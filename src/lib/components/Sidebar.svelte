<script lang="ts">
  import { untrack } from 'svelte';
  import { CLASS_COLORS, MAX_CLASSES, classShortcutLabel } from '$lib/constants';
  import { app } from '$lib/stores/app.svelte';
  import InputModal from './InputModal.svelte';
  import ConfirmModal from './ConfirmModal.svelte';
  import Select from './Select.svelte';

  let classesCollapsed = $state(false);
  let filtersCollapsed = $state(false);
  let showAddClassModal = $state(false);
  let removeClassTarget = $state<number | null>(null);
  let renameClassTarget = $state<number | null>(null);
  let showToggleConfirm = $state(false);

  let classFilterOptions = $derived.by(() => {
    const opts = [{ value: 'all', label: 'All classes' }];
    for (const [i, cls] of (app.current?.classes ?? []).entries()) {
      opts.push({ value: String(i), label: cls });
    }
    return opts;
  });

  function handleAddClass() {
    showAddClassModal = true;
  }

  function confirmAddClass(name: string) {
    showAddClassModal = false;
    app.addClass(name);
  }

  function handleRemoveClass(idx: number) {
    if (!app.current) return;
    const used = app.current.images.some(img => img.boxes.some(b => b.classIdx === idx));
    if (used) {
      removeClassTarget = idx;
    } else {
      app.removeClass(idx);
    }
  }

  function confirmRemoveClass() {
    if (removeClassTarget !== null) app.removeClass(removeClassTarget);
    removeClassTarget = null;
  }

  let visibleImages = $derived(app.filteredImages);

  // Single flag for the whole render: is the currently-shown image
  // outside the active filter? Computed once; previously each of the
  // ~868 rows ran filteredImages.some(...) per render — O(N^2) on the
  // image count, which dominated drag latency once a row mutation
  // re-rendered the sidebar.
  let currentOutOfFilter = $derived(
    !app.filteredImages.some(f => f.i === app.imgIndex)
  );

  // When the user changes a filter, navigate to the first image in the
  // new filtered set if the current one no longer matches. Without this,
  // the user is left looking at an image that doesn't fit their filter,
  // and clicking arrow-nav has confusing results.
  //
  // untrack() is load-bearing: snapToFilter reads filteredImages, which
  // reads img.reviewed and img.boxes on every image. Without untrack,
  // those become dependencies of this effect — so clicking any image
  // (which mutates reviewed via auto-mark) re-fires the effect, snaps
  // to the next image, marks that one too, cascading until the filter
  // is empty. With untrack, only the three filter values trigger.
  $effect(() => {
    app.filterAnnotation; app.filterReview; app.filterClass;
    untrack(() => app.snapToFilter());
  });

  // Auto-scroll the current image's row into view whenever the image
  // changes. Without this, the user has to scroll the sidebar manually
  // to find where they are after navigating with arrow keys or via the
  // canvas.
  let listEl: HTMLElement | undefined = $state();
  $effect(() => {
    app.imgIndex; // dependency
    visibleImages; // re-query after filter changes (DOM re-renders)
    if (!listEl) return;
    const row = listEl.querySelector(`[data-img-row="${app.imgIndex}"]`);
    if (row) row.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  });
</script>

<div class="sidebar">
  <div class="section" style="padding:7px 12px;">
    <div class="section-row">
      <span class="section-title" style="margin-bottom:0;">Project</span>
      <button class="btn-sm" onclick={async () => { await app.flushSave(); app.screen = 'projects'; }}>← Back</button>
    </div>
    <div class="project-name">{app.current?.name}</div>
  </div>

  <div class="section" class:collapsed={classesCollapsed}>
    <button class="section-title toggle" onclick={() => classesCollapsed = !classesCollapsed}>
      <span class="arrow">▾</span> Classes
    </button>
    {#if !classesCollapsed}
      <div class="section-body">
        {#each app.current?.classes ?? [] as cls, i}
          <div class="class-btn" class:active={i === app.activeClass}
            onclick={() => app.activeClass = i}
            ondblclick={(e) => { e.stopPropagation(); renameClassTarget = i; }}
            onkeydown={(e) => { if (e.key === 'Enter') app.activeClass = i; }}
            role="button" tabindex="0">
            <span class="swatch" style:background={CLASS_COLORS[i]}></span>
            <span>{cls}</span>
            <span class="shortcut">{classShortcutLabel(i)}</span>
            {#if (app.current?.classes.length ?? 0) > 1}
              <button class="cls-del" onclick={(e) => { e.stopPropagation(); handleRemoveClass(i); }}>✕</button>
            {/if}
          </div>
        {/each}
        {#if (app.current?.classes.length ?? 0) < MAX_CLASSES}
          <button class="btn-sm add-class" onclick={handleAddClass}>+ Add class</button>
        {/if}
      </div>
    {/if}
  </div>

  <div class="section" class:collapsed={filtersCollapsed}>
    <button class="section-title toggle" onclick={() => filtersCollapsed = !filtersCollapsed}>
      <span class="arrow">▾</span> Filters
    </button>
    {#if !filtersCollapsed}
      <div class="section-body">
        <Select bind:value={app.filterAnnotation} options={[
          { value: 'all', label: 'All images' },
          { value: 'annotated', label: 'Annotated' },
          { value: 'unannotated', label: 'Unannotated' },
        ]} />
        <Select bind:value={app.filterReview} options={[
          { value: 'all', label: 'Any review status' },
          { value: 'reviewed', label: 'Reviewed' },
          { value: 'unreviewed', label: 'Not reviewed' },
          { value: 'rereview', label: 'Requires re-review' },
        ]} />
        <Select bind:value={app.filterClass} options={classFilterOptions} />
        <button class="btn-sm" style="width:100%; margin-top:4px;" onclick={() => showToggleConfirm = true}>✓ Toggle reviewed</button>
      </div>
    {/if}
  </div>

  <div class="section-title" style="padding:10px 12px 4px;">
    Images ({app.filteredImages.length} shown)
  </div>
  <div class="img-list" bind:this={listEl}>
    {#if visibleImages.length === 0}
      <div class="empty-filter">No images match this filter.</div>
    {:else}
      {#each visibleImages as { img, i } (i)}
        {@const isCurrent = i === app.imgIndex}
        {@const outOfFilter = isCurrent && currentOutOfFilter}
        {@const dotClass = img.reviewed === true ? 'reviewed' : img.reviewed === false ? 'needs-review' : ''}
        <button class="img-item" class:active={isCurrent} class:out-of-filter={outOfFilter}
          data-img-row={i}
          onclick={() => app.setImageIndex(i)}
          ondblclick={() => app.toggleReviewedFor(img)}
          title={img.filename}>
          <div class="ann-dot {dotClass}"></div>
          <span class="img-name">{img.filename}</span>
          <span class="img-idx">{i + 1}</span>
        </button>
      {/each}
    {/if}
  </div>
</div>

{#if showAddClassModal}
  <InputModal title="New class name" placeholder="e.g. crack" onconfirm={confirmAddClass} oncancel={() => showAddClassModal = false} />
{/if}

{#if renameClassTarget !== null}
  <InputModal
    title="Rename class"
    defaultValue={app.current?.classes[renameClassTarget] ?? ''}
    onconfirm={(name) => { app.renameClass(renameClassTarget!, name); renameClassTarget = null; }}
    oncancel={() => renameClassTarget = null}
  />
{/if}

{#if removeClassTarget !== null}
  <ConfirmModal
    title="Remove class"
    message={`Class "${app.current?.classes[removeClassTarget]}" is used. Remove and reassign boxes to first class?`}
    onconfirm={confirmRemoveClass}
    oncancel={() => removeClassTarget = null}
  />
{/if}

{#if showToggleConfirm}
  {@const filteredCount = app.filteredImages.length}
  {@const allReviewed = app.filteredImages.every(({ img }) => img.reviewed === true)}
  <ConfirmModal
    title="Toggle reviewed"
    message={`${allReviewed ? 'Flag' : 'Mark'} all ${filteredCount} image${filteredCount === 1 ? '' : 's'} in the current filter as ${allReviewed ? 'requiring re-review' : 'reviewed'}?`}
    onconfirm={() => { app.toggleFilteredReviewed(); showToggleConfirm = false; }}
    oncancel={() => showToggleConfirm = false}
  />
{/if}

<style>
  .sidebar { width: 220px; flex-shrink: 0; background: var(--bg2); border-right: 1px solid var(--border); display: flex; flex-direction: column; overflow: hidden; }
  .section { padding: 12px; border-bottom: 1px solid var(--border); }
  .section-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
  .section-title { font-size: 10px; font-weight: 700; color: var(--text2); text-transform: uppercase; letter-spacing: .08em; margin-bottom: 8px; }
  .toggle { cursor: pointer; user-select: none; }
  .arrow { display: inline-block; font-size: 9px; transition: transform .15s; }
  .collapsed .arrow { transform: rotate(-90deg); }
  .section-body { display: flex; flex-direction: column; gap: 2px; }
  .project-name { font-size: 12px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .class-btn { display: flex; align-items: center; gap: 8px; width: 100%; padding: 5px 8px; border-radius: 4px; border: 1px solid transparent; border-left: 3px solid transparent; background: transparent; color: var(--text); cursor: pointer; font-size: 12px; text-align: left; }
  .class-btn:hover { background: var(--bg3); }
  .class-btn.active { background: var(--bg3); border-left-color: var(--accent); }
  .class-btn .swatch { width: 10px; height: 10px; border-radius: 2px; flex-shrink: 0; }
  .class-btn .shortcut { margin-left: auto; font-size: 9px; color: var(--text2); flex-shrink: 0; }
  .class-btn .cls-del { display: none; margin-left: auto; background: none; border: none; color: var(--text2); font-size: 11px; cursor: pointer; padding: 0 2px; flex-shrink: 0; }
  .class-btn:hover .shortcut { display: none; }
  .class-btn:hover .cls-del { display: block; }
  .class-btn .cls-del:hover { color: var(--danger); }
  .add-class { width: 100%; margin-top: 4px; font-size: 11px; }
  .img-list { flex: 1; overflow-y: auto; padding: 6px; }
  .img-item { display: flex; align-items: center; gap: 6px; width: 100%; padding: 4px 8px; border-radius: 3px; cursor: pointer; font-size: 11px; color: var(--text2); margin-bottom: 2px; border: 1px solid transparent; background: transparent; text-align: left; }
  .img-item:hover { background: var(--bg3); }
  .img-item.active { background: var(--bg3); border-color: var(--accent); color: var(--text); }
  .img-item.out-of-filter { border-color: var(--warn); }
  .ann-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; background: var(--border); }
  .ann-dot.reviewed { background: var(--success); }
  .ann-dot.needs-review { background: var(--warn); }
  .img-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .img-idx { font-size: 10px; color: var(--text2); flex-shrink: 0; }
  .empty-filter { padding: 12px; font-size: 11px; color: var(--text2); text-align: center; }
</style>
