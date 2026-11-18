# DSH workspace compatibility module

Derived from `@deepseek-ai/dsh-workspace@0.2.2-rc.1`, Copyright 2026 DeepSeek, under the accompanying MIT license.

`grouping.patch` shows the changes to the distributed module. `index.mjs` is the patched implementation. The installer loads it in the dedicated profile, using the matching DSH runtime's dependencies. It adds persistent display grouping for Super-agent sessions with individual execution directories.
