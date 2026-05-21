#!/usr/bin/env node
import('../dist/index.js').catch(err => { console.error(err.message); process.exit(1) })
