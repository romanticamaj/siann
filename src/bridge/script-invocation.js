const path = require('node:path');

// Runs a JavaScript file with the current Node executable, so a custom runner
// or runtime works on Windows too, where a shebang script cannot be spawned
// directly (spawn fails with EFTYPE). Any other path is executed as is.
function scriptInvocation(file, args = [], cwd = process.cwd()) {
  if (/\.[cm]?js$/i.test(path.extname(file))) {
    return { command: process.execPath, args: [file, ...args], cwd };
  }
  return { command: file, args, cwd };
}

module.exports = { scriptInvocation };
