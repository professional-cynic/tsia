// Toni's Simple Image Annotator (TSIA)
// © 2026 professional-cynic — https://codeberg.org/professional-cynic
// AGPL-3.0 — https://www.gnu.org/licenses/agpl-3.0.html

// ══════════════════════════════════════════════════════
// MAIN — boot the application
// ══════════════════════════════════════════════════════
import { state }         from './state.js';
import { loadProjects }  from './storage.js';
import { showScreen }    from './screens.js';

// Side-effect imports — these modules register event listeners on load
import './interaction.js';
import './export.js';
import './import.js';
import './annotate-ui.js';
import './boxes.js';
import './navigation.js';
import './projects.js';

// Boot
loadProjects();
if (state.projects.length > 0) {
  showScreen('projects');
}

// Expose state for inline HTML handlers that reference state.current
window.state = state;
