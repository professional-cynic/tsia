// ══════════════════════════════════════════════════════
// SCREEN MANAGEMENT
// ══════════════════════════════════════════════════════
import { renderProjects }  from './projects.js';
import { initNewProject }  from './import.js';
import { renderAnnotateUI } from './annotate-ui.js';

export function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + name).classList.add('active');
  if (name === 'projects') renderProjects();
  if (name === 'new')      initNewProject();
  if (name === 'annotate') renderAnnotateUI();
}

// Expose globally for onclick handlers in HTML
window.showScreen = showScreen;
