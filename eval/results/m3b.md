# Milestone 3b results: sparse n-gram prefilter for grep (spec B.4)

Generated 2026-09-03T15:10:00; release `sect`, 5 runs per query per mode, medians. In-process time is the prefilter plus the matcher scan as reported by `grep --json`; wall time includes process start-up and the freshness stat pass. Every query's total matches and per-file counts were compared between the two modes.

Command: `uv run --project proto python eval/eval_m3b.py --scaled 10` (exit 0 = median in-process speedup >= 5x on the three-title corpus, the GOAL.md gate).

## Gate

| Corpus | Files | Corpus MB | Index MB | Layer build | Fallbacks | Median in-process (scan / prefiltered) | Median in-process speedup | Median wall (scan / prefiltered) | Median wall speedup | Outputs identical |
|---|---|---|---|---|---|---|---|---|---|---|
| fixture (44 files) | 44 | 0.1 | 0.4 | 13 ms | 3 of 36 | 8.0 / 0.5 ms | **16.6x** | 26 / 19 ms | 1.4x | yes |
| three titles: 1, 4, 29 | 1942 | 5.7 | 4.9 | 4498 ms | 2 of 36 | 254.3 / 1.3 ms | **199.3x** | 300 / 48 ms | 6.3x | yes |
| 10 stacked copies of the three titles | 19420 | 57.8 | 25.3 | 4726 ms | 2 of 36 | 2544.7 / 8.7 ms | **294.0x** | 2854 / 315 ms | 9.1x | yes |

**Gate (three titles, median in-process speedup >= 5x): PASS (199.3x).**

## fixture (44 files)

| Query | Matches | Files matched | Candidates / files | Scan ms | Prefiltered ms | Speedup | Wall scan / prefiltered ms | Wall speedup | Note |
|---|---|---|---|---|---|---|---|---|---|
| `guardrail` | 32 | 8 | 8 / 48 | 7.9 | 0.6 | 14.0x | 26 / 19 | 1.3x |  |
| `-i guardrail` | 39 | 8 | 8 / 48 | 7.9 | 0.8 | 9.7x | 26 / 19 | 1.4x |  |
| `\bcage\b` | 13 | 3 | 3 / 48 | 8.2 | 0.5 | 15.1x | 28 / 20 | 1.4x |  |
| `top rail` | 7 | 2 | 2 / 48 | 8.0 | 0.3 | 24.0x | 26 / 19 | 1.4x |  |
| `42 inches` | 3 | 3 | 10 / 48 | 8.1 | 0.6 | 13.4x | 26 / 19 | 1.4x |  |
| `1926\.501` | 0 | 0 | 0 / 48 | 8.0 | 0.2 | 40.0x | 26 / 19 | 1.4x |  |
| `§ 1926\.502` | 0 | 0 | 0 / 48 | 8.0 | 0.2 | 35.0x | 26 / 19 | 1.4x |  |
| `respirator` | 0 | 0 | 0 / 48 | 7.7 | 0.2 | 39.0x | 26 / 18 | 1.4x |  |
| `fall protection` | 25 | 10 | 10 / 48 | 7.8 | 0.7 | 11.8x | 26 / 20 | 1.4x |  |
| `employer shall` | 46 | 18 | 24 / 48 | 7.7 | 1.1 | 6.7x | 26 / 20 | 1.3x |  |
| `personal protective equipment` | 0 | 0 | 0 / 48 | 7.8 | 0.2 | 32.0x | 26 / 18 | 1.4x |  |
| `\bPPE\b` | 0 | 0 | full scan | 7.8 | 7.6 | 1.0x | 26 / 26 | 1.0x | literal "PPE" produces no gram; full scan |
| `toe ?board` | 5 | 3 | 3 / 48 | 7.9 | 0.4 | 18.0x | 26 / 20 | 1.3x |  |
| `employ(er|ee)s?` | 165 | 37 | 37 / 48 | 8.1 | 1.8 | 4.5x | 27 / 21 | 1.3x |  |
| `\d+ feet` | 17 | 8 | 8 / 48 | 8.6 | 1.4 | 6.1x | 27 / 20 | 1.4x |  |
| `(?i)scaffold` | 1 | 1 | 1 / 48 | 8.0 | 0.7 | 11.8x | 26 / 19 | 1.4x |  |
| `training` | 17 | 8 | 9 / 48 | 7.8 | 0.6 | 12.5x | 26 / 19 | 1.3x |  |
| `competent person` | 1 | 1 | 1 / 48 | 7.7 | 0.3 | 27.2x | 26 / 19 | 1.4x |  |
| `qualified person` | 8 | 5 | 5 / 48 | 7.9 | 0.4 | 17.5x | 26 / 19 | 1.4x |  |
| `hazard communication` | 0 | 0 | 0 / 48 | 8.2 | 0.2 | 39.2x | 26 / 19 | 1.4x |  |
| `Federal Register` | 0 | 0 | 0 / 48 | 7.8 | 0.2 | 39.1x | 26 / 18 | 1.4x |  |
| `Office of the Federal Register` | 0 | 0 | 0 / 48 | 8.0 | 0.2 | 37.2x | 26 / 18 | 1.4x |  |
| `certif(y|ied|ication)` | 3 | 2 | 3 / 48 | 7.9 | 0.6 | 13.8x | 26 / 19 | 1.4x |  |
| `29 CFR` | 0 | 0 | 2 / 48 | 8.0 | 0.3 | 27.6x | 26 / 18 | 1.4x |  |
| `part 1910` | 0 | 0 | 0 / 48 | 8.2 | 0.2 | 42.7x | 27 / 19 | 1.5x |  |
| `subpart [A-Z]\b` | 0 | 0 | 0 / 48 | 8.0 | 0.4 | 19.7x | 26 / 19 | 1.3x |  |
| `\(a\)\(1\)` | 0 | 0 | 0 / 48 | 7.7 | 0.2 | 39.4x | 26 / 18 | 1.4x |  |
| `effective date` | 3 | 3 | 3 / 48 | 8.1 | 0.4 | 19.3x | 26 / 19 | 1.4x |  |
| `shall not` | 19 | 12 | 29 / 48 | 7.7 | 1.3 | 6.0x | 26 / 20 | 1.3x |  |
| `medical (examination|surveillance)` | 0 | 0 | 0 / 48 | 8.1 | 0.5 | 15.7x | 27 / 19 | 1.4x |  |
| `[Ll]adder` | 74 | 10 | 10 / 48 | 8.3 | 0.7 | 11.7x | 28 / 20 | 1.4x |  |
| `asbestos|lead|silica` | 4 | 3 | full scan | 8.0 | 7.8 | 1.0x | 28 / 28 | 1.0x | literal "lead" produces no gram; full scan |
| `minimum wage` | 0 | 0 | 0 / 48 | 7.8 | 0.2 | 44.4x | 27 / 20 | 1.4x |  |
| `child labor` | 0 | 0 | 0 / 48 | 8.0 | 0.2 | 42.4x | 27 / 20 | 1.4x |  |
| `\bOSHA\b` | 0 | 0 | full scan | 8.0 | 7.8 | 1.0x | 27 / 27 | 1.0x | literal "OSHA" produces no gram; full scan |
| `not less than \d+` | 1 | 1 | 1 / 48 | 9.0 | 1.3 | 7.0x | 29 / 21 | 1.4x |  |

## three titles: 1, 4, 29

| Query | Matches | Files matched | Candidates / files | Scan ms | Prefiltered ms | Speedup | Wall scan / prefiltered ms | Wall speedup | Note |
|---|---|---|---|---|---|---|---|---|---|
| `guardrail` | 0 | 0 | 0 / 1945 | 258.3 | 0.2 | 1601.3x | 307 / 46 | 6.7x |  |
| `-i guardrail` | 0 | 0 | 0 / 1945 | 251.6 | 0.4 | 628.9x | 298 / 46 | 6.4x |  |
| `\bcage\b` | 0 | 0 | 0 / 1945 | 252.1 | 0.3 | 847.2x | 300 / 48 | 6.2x |  |
| `top rail` | 0 | 0 | 0 / 1945 | 256.0 | 0.2 | 1606.3x | 305 / 46 | 6.6x |  |
| `42 inches` | 0 | 0 | 8 / 1945 | 253.3 | 0.5 | 472.4x | 299 / 46 | 6.5x |  |
| `1926\.501` | 0 | 0 | 0 / 1945 | 248.2 | 0.2 | 1341.6x | 296 / 47 | 6.3x |  |
| `§ 1926\.502` | 0 | 0 | 0 / 1945 | 254.3 | 0.2 | 1412.0x | 299 / 46 | 6.5x |  |
| `respirator` | 8 | 6 | 7 / 1945 | 252.1 | 0.5 | 459.9x | 299 / 47 | 6.4x |  |
| `fall protection` | 0 | 0 | 5 / 1945 | 254.0 | 0.5 | 538.2x | 304 / 48 | 6.3x |  |
| `employer shall` | 8 | 4 | 27 / 1945 | 258.7 | 1.3 | 201.6x | 306 / 48 | 6.4x |  |
| `personal protective equipment` | 0 | 0 | 1 / 1945 | 256.0 | 0.3 | 745.2x | 301 / 45 | 6.7x |  |
| `\bPPE\b` | 0 | 0 | full scan | 254.8 | 250.8 | 1.0x | 301 / 299 | 1.0x | literal "PPE" produces no gram; full scan |
| `toe ?board` | 0 | 0 | 0 / 1945 | 259.6 | 0.3 | 1027.1x | 307 / 46 | 6.6x |  |
| `employ(er|ee)s?` | 1081 | 408 | 491 / 1945 | 257.2 | 17.1 | 15.0x | 310 / 68 | 4.5x |  |
| `\d+ feet` | 0 | 0 | 0 / 1945 | 260.0 | 0.9 | 288.0x | 308 / 47 | 6.6x |  |
| `(?i)scaffold` | 2 | 2 | 2 / 1945 | 252.6 | 0.7 | 384.0x | 300 / 46 | 6.5x |  |
| `training` | 201 | 68 | 86 / 1945 | 251.2 | 3.3 | 77.1x | 299 / 49 | 6.1x |  |
| `competent person` | 0 | 0 | 11 / 1945 | 249.1 | 0.7 | 341.2x | 294 / 46 | 6.4x |  |
| `qualified person` | 2 | 2 | 56 / 1945 | 257.1 | 2.2 | 117.4x | 302 / 48 | 6.3x |  |
| `hazard communication` | 0 | 0 | 0 / 1945 | 255.8 | 0.2 | 1128.4x | 303 / 46 | 6.6x |  |
| `Federal Register` | 400 | 220 | 245 / 1945 | 249.9 | 8.5 | 29.4x | 298 / 56 | 5.3x |  |
| `Office of the Federal Register` | 78 | 61 | 109 / 1945 | 258.6 | 4.0 | 65.4x | 308 / 53 | 5.8x |  |
| `certif(y|ied|ication)` | 217 | 127 | 173 / 1945 | 256.6 | 6.9 | 37.3x | 304 / 54 | 5.6x |  |
| `29 CFR` | 164 | 102 | 102 / 1945 | 252.3 | 3.7 | 67.3x | 298 / 50 | 5.9x |  |
| `part 1910` | 0 | 0 | 0 / 1945 | 254.8 | 0.2 | 1666.5x | 300 / 45 | 6.7x |  |
| `subpart [A-Z]\b` | 43 | 39 | 1366 / 1945 | 251.4 | 45.2 | 5.6x | 300 / 92 | 3.2x |  |
| `\(a\)\(1\)` | 123 | 82 | 87 / 1945 | 252.1 | 3.5 | 72.8x | 298 / 50 | 6.0x |  |
| `effective date` | 44 | 30 | 86 / 1945 | 254.3 | 3.3 | 77.7x | 302 / 50 | 6.0x |  |
| `shall not` | 245 | 181 | 230 / 1945 | 259.2 | 8.4 | 30.8x | 308 / 58 | 5.3x |  |
| `medical (examination|surveillance)` | 13 | 2 | 20 / 1945 | 253.6 | 1.3 | 192.0x | 299 / 48 | 6.2x |  |
| `[Ll]adder` | 4 | 3 | 28 / 1945 | 255.1 | 1.3 | 196.9x | 300 / 47 | 6.4x |  |
| `asbestos|lead|silica` | 114 | 68 | 80 / 1945 | 260.6 | 3.0 | 85.9x | 306 / 49 | 6.2x |  |
| `minimum wage` | 118 | 62 | 112 / 1945 | 252.4 | 4.0 | 63.4x | 298 / 50 | 5.9x |  |
| `child labor` | 1 | 1 | 1 / 1945 | 253.4 | 0.3 | 895.3x | 300 / 45 | 6.6x |  |
| `\bOSHA\b` | 51 | 21 | full scan | 254.3 | 254.6 | 1.0x | 302 / 300 | 1.0x | literal "OSHA" produces no gram; full scan |
| `not less than \d+` | 19 | 14 | 55 / 1945 | 255.7 | 3.1 | 81.9x | 303 / 51 | 6.0x |  |

## 10 stacked copies of the three titles

| Query | Matches | Files matched | Candidates / files | Scan ms | Prefiltered ms | Speedup | Wall scan / prefiltered ms | Wall speedup | Note |
|---|---|---|---|---|---|---|---|---|---|
| `guardrail` | 0 | 0 | 0 / 19450 | 2555.3 | 0.2 | 14978.5x | 2855 / 306 | 9.3x |  |
| `-i guardrail` | 0 | 0 | 0 / 19450 | 2543.8 | 0.4 | 6342.1x | 2850 / 306 | 9.3x |  |
| `\bcage\b` | 0 | 0 | 0 / 19450 | 2528.6 | 0.3 | 8624.0x | 2833 / 306 | 9.3x |  |
| `top rail` | 0 | 0 | 0 / 19450 | 2536.8 | 0.2 | 15524.8x | 2843 / 306 | 9.3x |  |
| `42 inches` | 0 | 0 | 80 / 19450 | 2532.9 | 3.0 | 854.8x | 2834 / 308 | 9.2x |  |
| `1926\.501` | 0 | 0 | 0 / 19450 | 2549.5 | 0.2 | 14404.0x | 2858 / 308 | 9.3x |  |
| `§ 1926\.502` | 0 | 0 | 0 / 19450 | 2540.0 | 0.2 | 14801.8x | 2843 / 303 | 9.4x |  |
| `respirator` | 80 | 60 | 70 / 19450 | 2547.7 | 3.1 | 811.7x | 2854 / 312 | 9.1x |  |
| `fall protection` | 0 | 0 | 50 / 19450 | 2552.9 | 2.1 | 1235.8x | 2854 / 307 | 9.3x |  |
| `employer shall` | 80 | 40 | 270 / 19450 | 2538.4 | 9.6 | 264.1x | 2840 / 315 | 9.0x |  |
| `personal protective equipment` | 0 | 0 | 10 / 19450 | 2569.0 | 0.8 | 3359.9x | 2875 / 310 | 9.3x |  |
| `\bPPE\b` | 0 | 0 | full scan | 2540.6 | 2546.5 | 1.0x | 2843 / 2847 | 1.0x | literal "PPE" produces no gram; full scan |
| `toe ?board` | 0 | 0 | 0 / 19450 | 2541.2 | 0.3 | 9907.4x | 2843 / 304 | 9.3x |  |
| `employ(er|ee)s?` | 10810 | 4080 | 4910 / 19450 | 2556.2 | 175.8 | 14.5x | 2903 / 530 | 5.5x |  |
| `\d+ feet` | 0 | 0 | 0 / 19450 | 2558.1 | 0.9 | 2759.0x | 2863 / 310 | 9.2x |  |
| `(?i)scaffold` | 20 | 20 | 20 / 19450 | 2561.5 | 1.3 | 1971.3x | 2864 / 309 | 9.3x |  |
| `training` | 2010 | 680 | 860 / 19450 | 2553.2 | 30.6 | 83.4x | 2864 / 341 | 8.4x |  |
| `competent person` | 0 | 0 | 110 / 19450 | 2533.2 | 4.1 | 612.4x | 2837 / 308 | 9.2x |  |
| `qualified person` | 20 | 20 | 560 / 19450 | 2567.2 | 19.7 | 130.3x | 2872 / 324 | 8.9x |  |
| `hazard communication` | 0 | 0 | 0 / 19450 | 2537.7 | 0.2 | 10703.1x | 2845 / 308 | 9.2x |  |
| `Federal Register` | 4000 | 2200 | 2450 / 19450 | 2532.8 | 81.6 | 31.0x | 2851 / 405 | 7.0x |  |
| `Office of the Federal Register` | 780 | 610 | 1090 / 19450 | 2551.2 | 37.5 | 68.0x | 2865 / 344 | 8.3x |  |
| `certif(y|ied|ication)` | 2170 | 1270 | 1730 / 19450 | 2565.8 | 61.0 | 42.1x | 2878 / 377 | 7.6x |  |
| `29 CFR` | 1640 | 1020 | 1020 / 19450 | 2530.9 | 34.4 | 73.5x | 2838 / 347 | 8.2x |  |
| `part 1910` | 0 | 0 | 0 / 19450 | 2547.3 | 0.2 | 16287.3x | 2857 / 305 | 9.4x |  |
| `subpart [A-Z]\b` | 430 | 390 | 13660 / 19450 | 2545.6 | 440.9 | 5.8x | 2854 / 752 | 3.8x |  |
| `\(a\)\(1\)` | 1230 | 820 | 870 / 19450 | 2534.8 | 31.4 | 80.8x | 2845 / 345 | 8.2x |  |
| `effective date` | 440 | 300 | 860 / 19450 | 2549.4 | 29.2 | 87.4x | 2853 / 334 | 8.5x |  |
| `shall not` | 2450 | 1810 | 2300 / 19450 | 2537.4 | 82.7 | 30.7x | 2857 / 395 | 7.2x |  |
| `medical (examination|surveillance)` | 130 | 20 | 200 / 19450 | 2538.0 | 7.8 | 324.0x | 2849 / 316 | 9.0x |  |
| `[Ll]adder` | 40 | 30 | 280 / 19450 | 2563.8 | 10.3 | 249.9x | 2874 / 315 | 9.1x |  |
| `asbestos|lead|silica` | 1140 | 680 | 800 / 19450 | 2576.1 | 27.9 | 92.2x | 2890 / 337 | 8.6x |  |
| `minimum wage` | 1180 | 620 | 1120 / 19450 | 2543.7 | 37.1 | 68.6x | 2856 / 348 | 8.2x |  |
| `child labor` | 10 | 10 | 10 / 19450 | 2556.9 | 0.6 | 4070.2x | 2869 / 305 | 9.4x |  |
| `\bOSHA\b` | 510 | 210 | full scan | 2532.1 | 2548.9 | 1.0x | 2843 / 2855 | 1.0x | literal "OSHA" produces no gram; full scan |
| `not less than \d+` | 190 | 140 | 550 / 19450 | 2540.8 | 20.3 | 125.1x | 2843 / 324 | 8.8x |  |

## Linux (WSL2 on this box, ext4, 32 threads)

Same source and queries, run from the WSL2 copy (`eval/results/m3b-linux.md` is that run's full report):

| Corpus | Files | Median in-process (scan / prefiltered) | Median in-process speedup | Median wall (scan / prefiltered) | Median wall speedup | Outputs identical |
|---|---|---|---|---|---|---|
| fixture (44 files) | 44 | 1.3 / 0.2 ms | 5.6x | 5 / 4 ms | 1.2x | yes |
| three titles: 1, 4, 29 | 1942 | 37.9 / 0.5 ms | 75.1x | 55 / 17 ms | 3.2x | yes |

The walk is cheaper on ext4, so the in-process ratio is smaller than on NTFS but the gate holds. Wall time on Linux is bounded by process start plus the freshness stat (about 15 ms), not by grep.
