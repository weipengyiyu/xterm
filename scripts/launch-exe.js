'use strict';

// Keep the single EXE's foreground engine mode for headless callers.
const args = process.argv.slice(2);
if (args.includes('--no-open') || args.includes('--auto-exit')) {
  require('../server/index');
} else {
  require('./launch');
}
