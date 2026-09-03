# Milestone 3b results: sparse n-gram prefilter for grep (spec B.4)

Generated 2026-09-03T15:12:26; release `sect`, 5 runs per query per mode, medians. In-process time is the prefilter plus the matcher scan as reported by `grep --json`; wall time includes process start-up and the freshness stat pass. Every query's total matches and per-file counts were compared between the two modes.

Command: `uv run --project proto python eval/eval_m3b.py --scaled 10` (exit 0 = median in-process speedup >= 5x on the three-title corpus, the GOAL.md gate).

## Gate

| Corpus | Files | Corpus MB | Index MB | Layer build | Fallbacks | Median in-process (scan / prefiltered) | Median in-process speedup | Median wall (scan / prefiltered) | Median wall speedup | Outputs identical |
|---|---|---|---|---|---|---|---|---|---|---|
| fixture (44 files) | 44 | 0.1 | 0.4 | 7 ms | 3 of 36 | 1.3 / 0.2 ms | **5.6x** | 5 / 4 ms | 1.2x | yes |
| three titles: 1, 4, 29 | 1942 | 5.7 | 4.9 | 195 ms | 2 of 36 | 37.9 / 0.5 ms | **75.1x** | 55 / 17 ms | 3.2x | yes |

**Gate (three titles, median in-process speedup >= 5x): PASS (75.1x).**

## fixture (44 files)

| Query | Matches | Files matched | Candidates / files | Scan ms | Prefiltered ms | Speedup | Wall scan / prefiltered ms | Wall speedup | Note |
|---|---|---|---|---|---|---|---|---|---|
| `guardrail` | 32 | 8 | 8 / 48 | 1.3 | 0.2 | 5.4x | 5 / 4 | 1.2x |  |
| `-i guardrail` | 39 | 8 | 8 / 48 | 1.4 | 0.3 | 4.2x | 5 / 4 | 1.2x |  |
| `\bcage\b` | 13 | 3 | 3 / 48 | 1.3 | 0.2 | 5.5x | 5 / 4 | 1.1x |  |
| `top rail` | 7 | 2 | 2 / 48 | 1.3 | 0.2 | 6.9x | 5 / 4 | 1.3x |  |
| `42 inches` | 3 | 3 | 10 / 48 | 1.3 | 0.2 | 6.5x | 5 / 4 | 1.1x |  |
| `1926\.501` | 0 | 0 | 0 / 48 | 1.3 | 0.2 | 7.2x | 5 / 4 | 1.1x |  |
| `§ 1926\.502` | 0 | 0 | 0 / 48 | 1.3 | 0.2 | 8.5x | 5 / 4 | 1.2x |  |
| `respirator` | 0 | 0 | 0 / 48 | 1.2 | 0.1 | 8.9x | 5 / 4 | 1.1x |  |
| `fall protection` | 25 | 10 | 10 / 48 | 1.3 | 0.2 | 5.3x | 5 / 4 | 1.2x |  |
| `employer shall` | 46 | 18 | 24 / 48 | 1.4 | 0.3 | 4.1x | 5 / 5 | 1.2x |  |
| `personal protective equipment` | 0 | 0 | 0 / 48 | 1.3 | 0.2 | 7.2x | 5 / 4 | 1.2x |  |
| `\bPPE\b` | 0 | 0 | full scan | 1.4 | 1.4 | 1.0x | 5 / 6 | 1.0x | literal "PPE" produces no gram; full scan |
| `toe ?board` | 5 | 3 | 3 / 48 | 1.3 | 0.2 | 5.6x | 5 / 4 | 1.4x |  |
| `employ(er|ee)s?` | 165 | 37 | 37 / 48 | 1.5 | 0.5 | 3.1x | 6 / 5 | 1.3x |  |
| `\d+ feet` | 17 | 8 | 8 / 48 | 2.1 | 0.9 | 2.2x | 7 / 6 | 1.2x |  |
| `(?i)scaffold` | 1 | 1 | 1 / 48 | 1.6 | 0.5 | 3.3x | 6 / 5 | 1.2x |  |
| `training` | 17 | 8 | 9 / 48 | 1.3 | 0.3 | 5.0x | 5 / 5 | 1.2x |  |
| `competent person` | 1 | 1 | 1 / 48 | 1.3 | 0.2 | 6.8x | 5 / 4 | 1.2x |  |
| `qualified person` | 8 | 5 | 5 / 48 | 1.3 | 0.2 | 6.6x | 5 / 5 | 1.1x |  |
| `hazard communication` | 0 | 0 | 0 / 48 | 1.2 | 0.2 | 8.2x | 5 / 4 | 1.2x |  |
| `Federal Register` | 0 | 0 | 0 / 48 | 1.3 | 0.2 | 8.3x | 5 / 4 | 1.3x |  |
| `Office of the Federal Register` | 0 | 0 | 0 / 48 | 1.3 | 0.2 | 8.0x | 5 / 4 | 1.3x |  |
| `certif(y|ied|ication)` | 3 | 2 | 3 / 48 | 1.4 | 0.3 | 4.9x | 5 / 5 | 1.1x |  |
| `29 CFR` | 0 | 0 | 2 / 48 | 1.3 | 0.2 | 7.0x | 5 / 4 | 1.2x |  |
| `part 1910` | 0 | 0 | 0 / 48 | 1.3 | 0.2 | 7.7x | 5 / 4 | 1.2x |  |
| `subpart [A-Z]\b` | 0 | 0 | 0 / 48 | 1.4 | 0.3 | 5.0x | 5 / 4 | 1.2x |  |
| `\(a\)\(1\)` | 0 | 0 | 0 / 48 | 1.3 | 0.2 | 7.5x | 5 / 4 | 1.2x |  |
| `effective date` | 3 | 3 | 3 / 48 | 1.3 | 0.2 | 6.3x | 5 / 5 | 1.2x |  |
| `shall not` | 19 | 12 | 29 / 48 | 1.3 | 0.3 | 4.1x | 5 / 4 | 1.2x |  |
| `medical (examination|surveillance)` | 0 | 0 | 0 / 48 | 1.4 | 0.3 | 4.3x | 5 / 4 | 1.3x |  |
| `[Ll]adder` | 74 | 10 | 10 / 48 | 1.3 | 0.3 | 5.2x | 5 / 4 | 1.3x |  |
| `asbestos|lead|silica` | 4 | 3 | full scan | 1.3 | 1.5 | 0.9x | 5 / 6 | 0.9x | literal "lead" produces no gram; full scan |
| `minimum wage` | 0 | 0 | 0 / 48 | 1.3 | 0.1 | 9.1x | 5 / 4 | 1.2x |  |
| `child labor` | 0 | 0 | 0 / 48 | 1.3 | 0.1 | 8.7x | 6 / 4 | 1.3x |  |
| `\bOSHA\b` | 0 | 0 | full scan | 1.2 | 1.6 | 0.8x | 5 / 6 | 0.8x | literal "OSHA" produces no gram; full scan |
| `not less than \d+` | 1 | 1 | 1 / 48 | 2.2 | 1.1 | 2.1x | 7 / 5 | 1.3x |  |

## three titles: 1, 4, 29

| Query | Matches | Files matched | Candidates / files | Scan ms | Prefiltered ms | Speedup | Wall scan / prefiltered ms | Wall speedup | Note |
|---|---|---|---|---|---|---|---|---|---|
| `guardrail` | 0 | 0 | 0 / 1945 | 39.1 | 0.2 | 200.9x | 55 / 16 | 3.4x |  |
| `-i guardrail` | 0 | 0 | 0 / 1945 | 37.9 | 0.3 | 114.8x | 54 / 17 | 3.3x |  |
| `\bcage\b` | 0 | 0 | 0 / 1945 | 38.2 | 0.3 | 147.9x | 56 / 17 | 3.3x |  |
| `top rail` | 0 | 0 | 0 / 1945 | 37.5 | 0.2 | 188.3x | 54 / 17 | 3.2x |  |
| `42 inches` | 0 | 0 | 8 / 1945 | 37.9 | 0.3 | 135.5x | 54 / 17 | 3.3x |  |
| `1926\.501` | 0 | 0 | 0 / 1945 | 38.6 | 0.2 | 200.2x | 56 / 17 | 3.3x |  |
| `§ 1926\.502` | 0 | 0 | 0 / 1945 | 38.5 | 0.2 | 211.2x | 56 / 17 | 3.3x |  |
| `respirator` | 8 | 6 | 7 / 1945 | 39.3 | 0.3 | 130.2x | 57 / 18 | 3.2x |  |
| `fall protection` | 0 | 0 | 5 / 1945 | 38.4 | 0.3 | 141.6x | 55 / 17 | 3.2x |  |
| `employer shall` | 8 | 4 | 27 / 1945 | 37.8 | 0.4 | 86.2x | 54 / 17 | 3.2x |  |
| `personal protective equipment` | 0 | 0 | 1 / 1945 | 37.8 | 0.2 | 155.6x | 53 / 16 | 3.3x |  |
| `\bPPE\b` | 0 | 0 | full scan | 37.9 | 38.9 | 1.0x | 54 / 56 | 1.0x | literal "PPE" produces no gram; full scan |
| `toe ?board` | 0 | 0 | 0 / 1945 | 38.6 | 0.2 | 156.5x | 56 / 17 | 3.3x |  |
| `employ(er|ee)s?` | 1081 | 408 | 491 / 1945 | 38.1 | 3.5 | 10.9x | 59 / 24 | 2.4x |  |
| `\d+ feet` | 0 | 0 | 0 / 1945 | 40.1 | 0.8 | 47.9x | 58 / 19 | 3.1x |  |
| `(?i)scaffold` | 2 | 2 | 2 / 1945 | 38.1 | 0.4 | 87.0x | 54 / 17 | 3.3x |  |
| `training` | 201 | 68 | 86 / 1945 | 37.0 | 0.8 | 46.5x | 55 / 17 | 3.2x |  |
| `competent person` | 0 | 0 | 11 / 1945 | 38.2 | 0.3 | 116.1x | 55 / 17 | 3.3x |  |
| `qualified person` | 2 | 2 | 56 / 1945 | 37.6 | 0.6 | 60.9x | 53 / 17 | 3.1x |  |
| `hazard communication` | 0 | 0 | 0 / 1945 | 38.4 | 0.2 | 165.0x | 55 / 17 | 3.2x |  |
| `Federal Register` | 400 | 220 | 245 / 1945 | 37.2 | 1.6 | 22.7x | 54 / 19 | 2.9x |  |
| `Office of the Federal Register` | 78 | 61 | 109 / 1945 | 38.4 | 0.9 | 43.1x | 55 / 17 | 3.2x |  |
| `certif(y|ied|ication)` | 217 | 127 | 173 / 1945 | 37.5 | 1.5 | 25.6x | 55 / 19 | 2.9x |  |
| `29 CFR` | 164 | 102 | 102 / 1945 | 37.3 | 0.9 | 39.2x | 55 / 18 | 3.1x |  |
| `part 1910` | 0 | 0 | 0 / 1945 | 37.4 | 0.2 | 200.9x | 54 / 16 | 3.3x |  |
| `subpart [A-Z]\b` | 43 | 39 | 1366 / 1945 | 37.3 | 7.3 | 5.1x | 54 / 24 | 2.3x |  |
| `\(a\)\(1\)` | 123 | 82 | 87 / 1945 | 37.7 | 0.8 | 46.6x | 55 / 17 | 3.1x |  |
| `effective date` | 44 | 30 | 86 / 1945 | 37.1 | 0.8 | 45.6x | 53 / 17 | 3.1x |  |
| `shall not` | 245 | 181 | 230 / 1945 | 37.6 | 1.9 | 20.1x | 55 / 19 | 2.9x |  |
| `medical (examination|surveillance)` | 13 | 2 | 20 / 1945 | 38.0 | 0.6 | 66.8x | 54 / 17 | 3.2x |  |
| `[Ll]adder` | 4 | 3 | 28 / 1945 | 38.1 | 0.5 | 83.4x | 55 / 17 | 3.2x |  |
| `asbestos|lead|silica` | 114 | 68 | 80 / 1945 | 38.1 | 0.8 | 49.2x | 55 / 17 | 3.2x |  |
| `minimum wage` | 118 | 62 | 112 / 1945 | 37.1 | 0.9 | 42.2x | 55 / 17 | 3.2x |  |
| `child labor` | 1 | 1 | 1 / 1945 | 37.3 | 0.2 | 163.8x | 54 / 16 | 3.3x |  |
| `\bOSHA\b` | 51 | 21 | full scan | 38.1 | 37.5 | 1.0x | 54 / 54 | 1.0x | literal "OSHA" produces no gram; full scan |
| `not less than \d+` | 19 | 14 | 55 / 1945 | 38.4 | 1.3 | 28.4x | 54 / 18 | 3.0x |  |

