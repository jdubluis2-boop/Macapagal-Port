#!/usr/bin/env python3
"""Create a portable source archive without credentials, caches or runtime data."""
from pathlib import Path
import hashlib
import sys
import zipfile

root = Path(__file__).resolve().parents[1]
output = Path(sys.argv[1]) if len(sys.argv) > 1 else root / 'dist' / 'Macapagal-Port.zip'
output.parent.mkdir(parents=True, exist_ok=True)
root_files = ['.env.example', '.gitignore', 'README.md', 'START_HERE.md', 'package.json', 'package-lock.json', 'compose.yaml', 'playwright.config.ts', 'prisma.config.ts']
files = [root / name for name in root_files]
ignored = {'node_modules', '.next', '.git', 'test-results', 'playwright-report', '__pycache__', 'coverage', 'dist'}
for directory in ['apps', 'prisma', 'scripts', 'tests', 'docs']:
    for file in (root / directory).rglob('*'):
        relative = file.relative_to(root)
        if any(part in ignored for part in relative.parts):
            continue
        if file.is_file() and file.name != '.env' and not file.name.startswith('.env.') and not file.name.endswith(('.log', '.tsbuildinfo', '.pyc')):
            files.append(file)
with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for file in sorted(set(files)):
        if file.is_symlink() or not file.is_file() or not file.resolve().is_relative_to(root):
            raise SystemExit(f'Unsafe or missing source file: {file.name}')
        archive.write(file, 'Macapagal-Port/' + file.relative_to(root).as_posix())
with zipfile.ZipFile(output) as archive:
    if archive.testzip() is not None:
        raise SystemExit('Archive integrity check failed')
checksum = hashlib.sha256(output.read_bytes()).hexdigest()
output.with_suffix('.zip.sha256').write_text(f'{checksum}  {output.name}\n')
print(f'Created {output.name}: {len(files)} source files, {output.stat().st_size:,} bytes. Secrets and runtime data excluded.')
