<script lang="ts">
  import { app } from '$lib/stores/app.svelte';
  import { MAX_CLASSES } from '$lib/constants';
  import { mergeProjects, pickMergeFolder, cancelMerge, type MergePlan, type MergeProgressEvent } from '$lib/io/merge';
  import { loadAllProjects, registerProjectFolder } from '$lib/persistence';
  import type { Project } from '$lib/types';

  let phase = $state<'pick' | 'reconcile'>('pick');
  let selectedIds = $state<Set<string>>(new Set());
  let projectName = $state('Merged project');

  // canonicalNames: editable names for the SEED project's classes.
  // linkMaps[k]: for project k>=1, each class -> canonical index or -1 (new).
  let canonicalNames = $state<string[]>([]);
  let linkMaps = $state<number[][]>([]);

  const projects = $derived(app.projects);
  const selected = $derived(projects.filter(p => selectedIds.has(p.id)));

  type RunState =
    | { kind: 'config' }
    | { kind: 'running'; current: number; total: number; warnings: string[] }
    | { kind: 'error'; message: string };
  let runState = $state<RunState>({ kind: 'config' });

  function toggle(id: string) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    selectedIds = next;
  }

  const norm = (s: string) => s.trim().toLowerCase();

  function startReconcile() {
    const sel = selected;
    if (sel.length < 2) return;
    canonicalNames = [...sel[0].classes];
    const running = [...sel[0].classes];
    const maps: number[][] = [[]]; // index 0 unused (seed)
    for (let k = 1; k < sel.length; k++) {
      const map: number[] = [];
      for (const c of sel[k].classes) {
        const hit = running.findIndex(rc => norm(rc) === norm(c));
        if (hit >= 0) { map.push(hit); }
        else { running.push(c); map.push(-1); }
      }
      maps.push(map);
    }
    linkMaps = maps;
    phase = 'reconcile';
  }

  const plan = $derived.by((): { classes: string[]; maps: number[][] } | null => {
    const sel = selected;
    if (sel.length < 2) return null;
    const classes = [...canonicalNames];
    const maps: number[][] = [sel[0].classes.map((_, i) => i)];
    for (let k = 1; k < sel.length; k++) {
      const map: number[] = [];
      const lm = linkMaps[k] ?? [];
      for (let i = 0; i < sel[k].classes.length; i++) {
        const link = lm[i] ?? -1;
        if (link >= 0 && link < classes.length) {
          map.push(link);
        } else {
          classes.push(sel[k].classes[i]);
          map.push(classes.length - 1);
        }
      }
      maps.push(map);
    }
    return { classes, maps };
  });

  const mergedCount = $derived(plan ? plan.classes.length : 0);
  const overCap = $derived(mergedCount > MAX_CLASSES);

  const possibleDupes = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const p of selected) for (const img of p.images) {
      counts.set(img.filename, (counts.get(img.filename) ?? 0) + 1);
    }
    let n = 0;
    for (const c of counts.values()) if (c > 1) n += c - 1;
    return n;
  });

  const canonicalForDropdown = $derived(plan ? plan.classes : canonicalNames);

  function genId(): string {
    return `proj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  async function runMerge() {
    if (!plan || overCap || selected.length < 2) return;
    const outDir = await pickMergeFolder();
    if (!outDir) return;

    const mergePlan: MergePlan = {
      mergedClasses: plan.classes,
      classMaps: plan.maps,
      projectName: projectName.trim() || 'Merged project',
      projectId: genId(),
    };

    const total = selected.reduce((s, p) => s + p.images.length, 0);
    runState = { kind: 'running', current: 0, total, warnings: [] };

    try {
      const mergedPath = await mergeProjects(selected, mergePlan, {
        outDir,
        onProgress: (e: MergeProgressEvent) => {
          if (runState.kind !== 'running') return;
          if (e.kind === 'item') runState.current = e.data.current;
          else if (e.kind === 'warning') runState.warnings.push(`${e.data.filename}: ${e.data.message}`);
          else if (e.kind === 'failed') runState = { kind: 'error', message: e.data.message };
        },
      });
      // The merge created a new folder with a tsia-project.json in it, but
      // nothing is in the registry yet — register it so loadAllProjects finds
      // it. Empty path means the merge was cancelled; nothing to register.
      if (mergedPath) {
        await registerProjectFolder(mergedPath);
        app.projects = await loadAllProjects();
        app.screen = 'projects';
      } else {
        runState = { kind: 'config' };
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      runState = { kind: 'error', message };
    }
  }

  async function cancel() {
    await cancelMerge();
    runState = { kind: 'config' };
  }
</script>

<div class="merge">
  <div class="topbar">
    <span class="topbar-title">Merge Projects</span>
    <span style="flex:1"></span>
    <button onclick={() => app.screen = 'projects'}>← Projects</button>
  </div>
  <div class="inner">
  {#if runState.kind === 'running'}
    <div class="card">
      <div class="card-title">Merging</div>
      <p>{runState.current} / {runState.total} images copied.</p>
      <progress value={runState.current} max={runState.total}></progress>
    </div>
    <div class="actions">
      <button onclick={cancel}>Cancel</button>
    </div>
  {:else if runState.kind === 'error'}
    <div class="card">
      <div class="card-title">Merge failed</div>
      <p class="create-error">{runState.message}</p>
    </div>
    <div class="actions">
      <button onclick={() => runState = { kind: 'config' }}>Back</button>
    </div>
  {:else if phase === 'pick'}
    <div class="card">
      <div class="card-title">Select projects</div>
      <p class="hint">Pick two or more projects to merge. They'll be copied into a new folder; the originals are untouched.</p>
      <div class="picklist">
        {#each projects as p}
          <label class="prow">
            <input type="checkbox" checked={selectedIds.has(p.id)} onchange={() => toggle(p.id)} />
            <span class="pname">{p.name}</span>
            <span class="pmeta">{p.images.length} images · {p.classes.length} classes</span>
          </label>
        {/each}
      </div>
    </div>
    <div class="actions">
      <button class="btn-primary" disabled={selected.length < 2} onclick={startReconcile}>
        Next: reconcile {selected.length} project{selected.length === 1 ? '' : 's'}
      </button>
    </div>
  {:else}
    <div class="card">
      <div class="card-title">Merged Project Name</div>
      <input id="mname" type="text" bind:value={projectName} />
    </div>

    <div class="card">
      <div class="card-title">Classes</div>
      <p class="hint">
        Classes from <strong>{selected[0].name}</strong> seed the list (edit any name to set its
        canonical spelling). Each following project links its classes to existing ones or adds them as new.
      </p>

      <div class="sub-title">{selected[0].name} (base classes)</div>
      {#each canonicalNames as _, i}
        <input class="cls" type="text" bind:value={canonicalNames[i]} />
      {/each}

      {#each selected.slice(1) as proj, k1}
        {@const k = k1 + 1}
        <div class="sub-title">{proj.name}</div>
        {#each proj.classes as bc, i}
          <div class="brow">
            <span class="bname">{bc}</span>
            <select bind:value={linkMaps[k][i]}>
              <option value={-1}>↳ add as new class</option>
              {#each canonicalForDropdown as mn, mi}
                <option value={mi}>= {mn}</option>
              {/each}
            </select>
          </div>
        {/each}
      {/each}

      <div class="summary" class:over={overCap}>
        Merged classes: {mergedCount} / {MAX_CLASSES}
        {#if overCap}— too many. Link more classes to existing ones to get under {MAX_CLASSES}.{/if}
      </div>

      {#if possibleDupes > 0}
        <div class="warn">
          {possibleDupes} image{possibleDupes === 1 ? '' : 's'} share a filename across the selected
          projects. Images are copied under source-prefixed names, so a shared photo will appear more than once.
        </div>
      {/if}
    </div>

    <div class="actions">
      <button onclick={() => phase = 'pick'}>← Back</button>
      <span style="flex:1"></span>
      <button class="btn-primary" disabled={overCap} onclick={runMerge}>Merge into new folder…</button>
    </div>
  {/if}
  </div>
</div>

<style>
  .merge { flex: 1; width: 100%; display: flex; flex-direction: column; height: 100%; overflow: hidden; color: var(--text); }
  .topbar { background: var(--bg2); border-bottom: 1px solid var(--border); padding: 10px 20px; display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
  .topbar-title { font-size: 14px; font-weight: 700; letter-spacing: 0.05em; }

  .inner { flex: 1; overflow-y: auto; max-width: 540px; margin: 0 auto; padding: 24px; width: 100%; }
  .card { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius, 10px); padding: 16px; margin-bottom: 12px; }
  .card-title { font-size: 12px; font-weight: 700; margin-bottom: 8px; text-transform: uppercase; letter-spacing: .05em; color: var(--text2); }
  .sub-title { font-size: 11px; font-weight: 600; color: var(--text2); margin: 12px 0 6px; }
  .hint { font-size: 10px; color: var(--text2); margin-bottom: 8px; line-height: 1.5; }
  .actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 16px; }

  input[type="text"], select {
    background: var(--bg3); border: 1px solid var(--border); border-radius: 6px;
    color: var(--text); padding: 7px 9px; font-size: 12px; font-family: inherit; width: 100%;
  }
  .cls { margin-bottom: 6px; }

  .picklist { display: flex; flex-direction: column; gap: 2px; }
  .prow { display: flex; align-items: center; gap: 10px; padding: 7px 8px; border-radius: 6px; cursor: pointer; }
  .prow:hover { background: var(--bg3); }
  .pname { font-size: 13px; }
  .pmeta { font-size: 11px; color: var(--text2); margin-left: auto; }

  .brow { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .bname { font-size: 12px; flex-shrink: 0; min-width: 110px; color: var(--text2); }
  .brow select { max-width: 280px; }

  .summary { margin-top: 14px; font-size: 12px; color: var(--text2); }
  .summary.over { color: var(--warn); font-weight: 600; }
  .warn { margin-top: 10px; font-size: 11px; color: var(--warn); line-height: 1.5; }

  progress { width: 100%; margin: 10px 0; }
  .create-error { font-size: 12px; color: var(--danger, var(--warn)); word-break: break-word; }
</style>
