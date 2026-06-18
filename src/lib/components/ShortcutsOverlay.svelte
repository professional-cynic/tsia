<script lang="ts">
  import { app } from '$lib/stores/app.svelte';

  // Grouped shortcut definitions. Each group renders as a titled block in a
  // responsive two-column grid, so adding rows here doesn't make the modal
  // a single unreadable column.
  const groups: { title: string; items: { keys: string[]; sep?: string; desc: string }[] }[] = [
    {
      title: 'Navigation',
      items: [
        { keys: ['A', 'D'], sep: '/', desc: 'Previous / next image' },
        { keys: ['Scroll'], desc: 'Zoom in / out' },
        { keys: ['Middle drag'], desc: 'Pan' },
      ],
    },
    {
      title: 'Selection',
      items: [
        { keys: ['Click'], desc: 'Select one box' },
        { keys: ['Shift', 'Click'], sep: '+', desc: 'Select multiple (add / remove a box)' },
        { keys: ['Drag'], desc: 'Move box — moves whole group if multi-selected' },
        { keys: ['Esc'], desc: 'Deselect all' },
      ],
    },
    {
      title: 'Editing',
      items: [
        { keys: ['1', '9'], sep: '…', desc: 'Set class / reassign selected' },
        { keys: ['0'], desc: 'Set class 10' },
        { keys: ['Arrows'], desc: 'Nudge selection 1 px (whole group if multi)' },
        { keys: ['Shift', 'Arrows'], sep: '+', desc: 'Nudge selection by 10 px' },
        { keys: ['Del'], desc: 'Delete selected box(es)' },
        { keys: ['Shift', 'Del'], sep: '+', desc: 'Remove current image from project (undoable)' },
        { keys: ['X'], desc: 'Toggle needs re-review' },
        { keys: ['Ctrl', 'Z'], sep: '+', desc: 'Undo (chronological)' },
      ],
    },
    {
      title: 'Clipboard',
      items: [
        { keys: ['Ctrl', 'C'], sep: '+', desc: 'Copy selected box(es)' },
        { keys: ['Ctrl', 'V'], sep: '+', desc: 'Paste onto current image' },
        { keys: ['C'], desc: 'Copy all boxes from previous image' },
      ],
    },
    {
      title: 'View',
      items: [
        { keys: ['F11'], desc: 'Toggle fullscreen' },
        { keys: ['?'], desc: 'Toggle this help' },
      ],
    },
  ];

  const statuses: { color: string; label: string }[] = [
    { color: 'var(--border)', label: 'Not reviewed' },
    { color: 'var(--success)', label: 'Reviewed' },
    { color: 'var(--warn)', label: 'Needs re-review' },
  ];
</script>

<div class="overlay" role="presentation"
  onclick={(e) => { if (e.target === e.currentTarget) app.showHelp = false; }}>
  <div class="card" role="dialog" aria-modal="true" aria-label="Keyboard Shortcuts" tabindex="-1">
    <div class="head">
      <span class="title">Keyboard Shortcuts</span>
      <button class="close" onclick={() => app.showHelp = false} aria-label="Close">✕</button>
    </div>

    <div class="grid">
      {#each groups as group}
        <section class="group">
          <h3>{group.title}</h3>
          {#each group.items as item}
            <div class="row">
              <span class="keys">
                {#each item.keys as k, i}
                  {#if i > 0 && item.sep}<span class="sep">{item.sep}</span>{/if}
                  <kbd>{k}</kbd>
                {/each}
              </span>
              <span class="desc">{item.desc}</span>
            </div>
          {/each}
        </section>
      {/each}

      <section class="group">
        <h3>Image Status</h3>
        {#each statuses as s}
          <div class="row">
            <span class="keys"><span class="dot" style:background={s.color}></span></span>
            <span class="desc">{s.label}</span>
          </div>
        {/each}
      </section>
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.5);
    z-index: 100; display: flex; align-items: center; justify-content: center;
    padding: 24px;
  }
  .card {
    background: var(--bg2); border: 1px solid var(--border); border-radius: 10px;
    padding: 20px 24px 24px; color: var(--text2); max-width: 720px; width: 100%;
    max-height: 85vh; overflow-y: auto;
  }
  .head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
  .title { font-weight: 700; font-size: 14px; color: var(--text); }
  .close {
    background: none; border: none; color: var(--text2); cursor: pointer;
    font-size: 14px; padding: 4px 8px; border-radius: 4px; line-height: 1;
  }
  .close:hover { background: var(--bg3); color: var(--text); }

  .grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
    gap: 18px 28px;
  }
  .group h3 {
    margin: 0 0 8px; font-size: 11px; font-weight: 700; color: var(--text);
    text-transform: uppercase; letter-spacing: 0.05em;
    border-bottom: 1px solid var(--border); padding-bottom: 5px;
  }
  .row { display: flex; align-items: baseline; gap: 10px; margin-bottom: 6px; font-size: 11px; }
  .keys { flex-shrink: 0; min-width: 92px; display: flex; align-items: center; gap: 3px; flex-wrap: wrap; }
  .sep { color: var(--text2); font-size: 10px; }
  .desc { color: var(--text2); line-height: 1.4; }

  kbd {
    display: inline-block; background: var(--bg3); border: 1px solid var(--border);
    border-radius: 4px; padding: 1px 6px; font-size: 10px; font-family: inherit;
    color: var(--text); white-space: nowrap;
  }
  .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; }
</style>
