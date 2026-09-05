# Recorded results

These are dated experiment records. A result describes the binary, generation,
inputs and limitations it records. Later code changes do not retroactively update
its measurements. Failed and incomplete experiments are retained as such.
Git preserves the original bytes of JSON reports and evaluation bindings, including
line endings, so checkout does not silently change recorded hashes.

## Large query captures

Eight scale-query reports are stored as lossless `.json.gz` archives. They include
complete returned evidence and large repeated manifest diagnostics. Together they
contain roughly 97 MB of original JSON; compression avoids adding that repetition
as text to repository reviews. The original local `.json` files remain ignored.

[archives.json](archives.json) records the SHA-256 and length of both the archive and
the **exact original bytes**. Historical parity reports still name and hash those
original `.json` bytes. No fields, timestamps, timings or hashes were rewritten.
CI decompresses every archive, checks both hashes and validates the final parity
report's original input bindings.

Read one without extracting it (from the repository root):

```sh
python -c "import gzip,json; p='eval/results/needle-scale-final-windows-2026-09-05.json.gz'; r=json.load(gzip.open(p, 'rt', encoding='utf-8-sig')); print(json.dumps(r['warm_mcp'], indent=2))"
```

To restore the original path for an older analysis script, this command refuses to
overwrite an existing file:

```sh
python -c "import gzip,pathlib; p=pathlib.Path('eval/results/needle-scale-final-windows-2026-09-05.json.gz'); p.with_suffix('').open('xb').write(gzip.decompress(p.read_bytes()))"
```

The [scale implementation report](../../docs/needle-scale-implementation.md) provides
readable measurements and links to individual captures. The
[compiled-cache report](../../docs/compiled-passage-cache.md) records subsequent
incremental-update measurements. Consult the [evaluation guide](../README.md) before
using timing or parser agreement as a quality claim.
