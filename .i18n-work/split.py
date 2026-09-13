import pathlib

OUT = pathlib.Path(__file__).resolve().parent / 'chunks'
OUT.mkdir(exist_ok=True)
ROOT = pathlib.Path(__file__).resolve().parent.parent

jobs = [
    ('docs/superpowers/2026-09-06-subagent-model-routing-design.md', 'design', [1, 245]),
    ('docs/superpowers/specs/2026-09-06-subagent-model-routing-design.md', 'spec', [1, 299]),
    ('docs/superpowers/plans/2026-09-06-subagent-model-routing.md', 'plan',
     [1, 235, 1024, 1610, 2249, 2941]),
]

for src, name, starts in jobs:
    lines = (ROOT / src).read_text(encoding='utf-8').split('\n')
    total = len(lines)
    bounds = [s - 1 for s in starts] + [total]
    for i in range(len(starts)):
        part = lines[bounds[i]:bounds[i + 1]]
        text = '\n'.join(part)
        fences = text.count('```')
        p = OUT / f'{name}-{i + 1}.md'
        p.write_text(text, encoding='utf-8')
        print(f'{p.name} lines={len(part)} fences={fences} balanced={fences % 2 == 0}')
