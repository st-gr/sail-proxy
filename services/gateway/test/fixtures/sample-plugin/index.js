// A plugin package as an author would ship it: compiled JavaScript, a helper and a non-JavaScript file.
const { readNote } = require('./lib/note');

module.exports = [
  {
    id: 'samplePlugin',
    match: [],
    strategy: 'before',
    handler: async ({ req }) => {
      req.body.sampleNote = readNote();
      return { stop: false };
    },
  },
];
