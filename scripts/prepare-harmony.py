#!/usr/bin/env python3
"""Copy a root-path Web build into HarmonyOS's offline, allowlisted resources."""
from __future__ import annotations

import argparse
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import tempfile

ROOT = Path(__file__).resolve().parents[1]
RESOURCE_ROOT = ROOT / 'harmony/entry/src/main/resources/rawfile'
PRIVATE_SUFFIXES = {'.pem', '.key', '.p8', '.p12', '.p7b', '.mobileprovision', '.jks', '.keystore', '.sqlite', '.db', '.log'}
PDF_LICENSES = {
    'pdfjs/cmaps/LICENSE', 'pdfjs/standard_fonts/LICENSE_LIBERATION',
    'pdfjs/standard_fonts/LICENSE_FOXIT', 'pdfjs/wasm/LICENSE_JBIG2',
    'pdfjs/wasm/LICENSE_QCMS', 'pdfjs/wasm/LICENSE_PDFJS_JBIG2',
    'pdfjs/wasm/LICENSE_OPENJPEG', 'pdfjs/wasm/LICENSE_PDFJS_OPENJPEG',
    'pdfjs/wasm/LICENSE_PDFJS_QCMS',
}
MIME = {
    '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript',
    '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
    '.wasm': 'application/wasm', '.pdf': 'application/pdf', '.txt': 'text/plain',
    '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream',
}


class EntryReferences(HTMLParser):
    def __init__(self):
        super().__init__()
        self.paths: list[str] = []

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        path = values.get('src') if tag == 'script' else values.get('href') if tag == 'link' else None
        if path:
            self.paths.append(path)


def collect_assets(source: Path):
    if source.is_symlink() or not source.is_dir():
        raise ValueError('Web build must be an existing directory, not a symlink.')
    files = sorted(source.rglob('*'))
    if any(path.is_symlink() for path in files):
        raise ValueError('Symlinked Web resources are not allowed.')
    assets = []
    total = 0
    for path in files:
        if path.is_dir():
            continue
        relative = path.relative_to(source).as_posix()
        parts = PurePosixPath(relative).parts
        suffixes = {suffix.lower() for suffix in path.suffixes}
        if not path.is_file() or suffixes & PRIVATE_SUFFIXES or any(not re.fullmatch(r'[A-Za-z0-9_@+.-]+', part) or part.startswith('.') for part in parts):
            raise ValueError('Unexpected resource filename in Web build.')
        mime = MIME.get(path.suffix.lower())
        if relative in PDF_LICENSES:
            mime = 'text/plain'
        if mime is None:
            raise ValueError('Unsupported resource type in Web build.')
        size = path.stat().st_size
        total += size
        if size > 20 * 1024**2 or total > 100 * 1024**2 or len(assets) >= 5000:
            raise ValueError('Web resources exceed the packaging limits.')
        assets.append({'path': '/' + relative, 'mime': mime,
                       'size': size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    known = {asset['path'] for asset in assets}
    if '/index.html' not in known:
        raise ValueError('Missing built index.html; run npm run build first.')
    parser = EntryReferences()
    parser.feed((source / 'index.html').read_text(encoding='utf-8'))
    if not parser.paths or any(path not in known for path in parser.paths):
        raise ValueError('HarmonyOS requires a complete Web build with QINGREAD_WEB_BASE=/ .')
    return assets


def prepare(source: Path, destination: Path = RESOURCE_ROOT):
    assets = collect_assets(source)
    if destination.is_symlink() or any(parent.is_symlink() for parent in destination.parents):
        raise ValueError('Resource destination must not contain symlinks.')
    destination.mkdir(parents=True, exist_ok=True)
    target = destination / 'web'
    index = destination / 'qingread-assets.json'
    if target.is_symlink() or index.is_symlink():
        raise ValueError('Generated resource paths must not be symlinks.')
    if source == target or target in source.parents or source in target.parents:
        raise ValueError('Input and generated resource directories must be separate.')
    stage = Path(tempfile.mkdtemp(prefix='.qingread-stage-', dir=destination))
    backup = stage / 'previous-web'
    published = False
    old_index = index.read_bytes() if index.exists() else None
    try:
        for asset in assets:
            relative = asset['path'][1:]
            output = stage / 'web' / relative
            output.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source / relative, output)
            if hashlib.sha256(output.read_bytes()).hexdigest() != asset['sha256']:
                raise ValueError('A Web resource changed while packaging.')
        metadata = {'schemaVersion': 1, 'assets': assets}
        staged_index = stage / 'qingread-assets.json'
        staged_index.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        if target.exists():
            if not index.exists():
                raise ValueError('Refusing to replace an unrecognized resource directory.')
            os.replace(target, backup)
        os.replace(stage / 'web', target)
        published = True
        os.replace(staged_index, index)
    except BaseException:
        if published:
            shutil.rmtree(target)
        if backup.exists():
            os.replace(backup, target)
        if old_index is not None:
            index.write_bytes(old_index)
        raise
    finally:
        shutil.rmtree(stage)
    return len(assets)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--web-dist', type=Path, required=True)
    args = parser.parse_args()
    try:
        count = prepare(args.web_dist.absolute())
    except (OSError, ValueError) as error:
        parser.exit(1, f'HarmonyOS assets not prepared: {error}\n')
    print(f'Prepared {count} allowlisted offline Web resources.')


if __name__ == '__main__':
    main()
