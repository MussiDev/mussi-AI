// Why this file exists: the package's "exports" map has no "types" entry, so
// NodeNext cannot find its bundled index.d.ts. Re-export it under the bare
// module name. Delete this file once the package adds a "types" entry.
declare module 'better-sqlite3-multiple-ciphers' {
  import Database = require('../../node_modules/better-sqlite3-multiple-ciphers/index');
  export = Database;
}
