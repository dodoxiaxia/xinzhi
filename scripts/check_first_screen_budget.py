#!/usr/bin/env python3
"""Check first-screen critical asset and tier-1 data size budgets for an existing public/ build."""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import public_split
from public_split import (
    check_first_screen_budget,
    measure_first_screen,
    read_critical_payloads,
)

DEFAULT_PUBLIC = Path(__file__).resolve().parents[1] / 'public'


def format_report_table(report, data_budget_br=None, total_budget_br=None, gzip_ratio=None):
    if data_budget_br is None:
        data_budget_br = public_split.FIRST_SCREEN_DATA_BUDGET_BR
    if total_budget_br is None:
        total_budget_br = public_split.FIRST_SCREEN_TOTAL_BUDGET_BR
    if gzip_ratio is None:
        gzip_ratio = public_split.FIRST_SCREEN_GZIP_TO_BR_RATIO
    br_on = report['brotliAvailable']
    data_budget_gz = int(round(data_budget_br * gzip_ratio))
    total_budget_gz = int(round(total_budget_br * gzip_ratio))
    rows = [
        (row['path'], str(row['raw']), str(row['gzip']), str(row['br']) if br_on else 'skipped')
        for row in report['criticalFiles']
    ]
    data = report['data']
    total = report['total']
    data_label = f"Tier-1 data ({report['dataStatements']} stmts)"
    total_label = 'Total critical'
    name_width = max([len('File'), len(data_label), len(total_label)] + [len(r[0]) for r in rows]) + 2
    lines = [
        f"{'File':<{name_width}} {'Raw':>10} {'Gzip(9)':>10} {'Brotli(11)':>12}",
        '-' * (name_width + 35),
    ]
    for name, raw, gz, br in rows:
        lines.append(f'{name:<{name_width}} {raw:>10} {gz:>10} {br:>12}')
    lines.append('-' * (name_width + 35))
    data_br_str = str(data['br']) if br_on else 'skipped'
    total_br_str = str(total['br']) if br_on else 'skipped'
    lines.append(
        f"{data_label:<{name_width}} {data['raw']:>10} {data['gzip']:>10} {data_br_str:>12}"
        f"  (budget: gzip <= {data_budget_gz}, br <= {data_budget_br})"
    )
    lines.append(
        f"{total_label:<{name_width}} {total['raw']:>10} {total['gzip']:>10} {total_br_str:>12}"
        f"  (budget: gzip <= {total_budget_gz}, br <= {total_budget_br})"
    )
    if not br_on:
        lines.append('Note: brotli module unavailable; skipped brotli(11) and checked gzip(9) only.')
    return '\n'.join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('public_dir', nargs='?', default=str(DEFAULT_PUBLIC), help='Built public directory (default: public/)')
    args = parser.parse_args(argv)
    public_dir = Path(args.public_dir)
    if not public_dir.is_dir():
        print(f'ERROR: public directory does not exist: {public_dir}', file=sys.stderr)
        return 1
    try:
        payloads = read_critical_payloads(public_dir)
        report = measure_first_screen(payloads)
    except (OSError, ValueError) as exc:
        print(f'ERROR: {exc}', file=sys.stderr)
        return 1
    print(f'First-screen critical assets ({public_dir}):')
    print(format_report_table(report))
    try:
        check_first_screen_budget(payloads)
    except ValueError as exc:
        print(f'FAIL: {exc}', file=sys.stderr)
        return 1
    print('PASS: first-screen budget within limits.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
