// Test fixture only — paired with detachedGrandchildProcess.js. Stays alive
// holding an inherited stdout fd open, standing in for a process that has
// escaped its parent's process group (via its own detached: true) and
// therefore survives a group-kill aimed at that parent.
setInterval(() => {}, 1000);
