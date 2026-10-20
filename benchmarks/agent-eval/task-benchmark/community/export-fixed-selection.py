import argparse, pathlib, json, ast, hashlib
import pyarrow as pa
import pyarrow.parquet as pq

parser = argparse.ArgumentParser(description='Re-export the fixed 24-task community benchmark from verified original Parquet files.')
parser.add_argument('--context-parquet', required=True, type=pathlib.Path)
parser.add_argument('--swe-parquet', required=True, type=pathlib.Path)
parser.add_argument('--out', required=True, type=pathlib.Path, help='New private output directory; must not exist')
args = parser.parse_args()
for supplied in (args.context_parquet, args.swe_parquet, args.out):
    if not supplied.is_absolute():
        parser.error('All input/output paths must be absolute')
ROOT = args.out
plan = json.loads(pathlib.Path(__file__).with_name('selection-fixed-24.json').read_text(encoding='utf8'))
selection = plan['selections']
expected = {
    'swebench-multilingual-verified.parquet':'92abca7cb527b41a9f66d03a26ce441ff7319e3a49f985998fd56be4bb9b08b2',
    'context-full-verified.parquet':'2f56535bdc73eb8a68bf4ebb49789d8e9cd4f219ea60df6290b85278aee61ca8',
}
for name, digest in expected.items():
    if hashlib.sha256(({'swebench-multilingual-verified.parquet': args.swe_parquet, 'context-full-verified.parquet': args.context_parquet}[name]).read_bytes()).hexdigest()!=digest:
        raise RuntimeError(f'Original dataset SHA256 mismatch: {name}')
swe_rows=pq.read_table(args.swe_parquet).to_pylist()
context_table=pq.read_table(args.context_parquet)
context_rows=context_table.to_pylist()
assert len(swe_rows)==300 and len(context_rows)==1136
swe={row['instance_id']:row for row in swe_rows}
contexts={row['original_inst_id']:row for row in context_rows}

def dump_lines(name, rows):
    ((PRIVATE if name.startswith('private-') else ROOT)/name).write_text(''.join(json.dumps(row,ensure_ascii=False)+'\n' for row in rows),encoding='utf8')

ROOT.mkdir(parents=True, exist_ok=False)
PRIVATE = ROOT / 'private-grading'
PRIVATE.mkdir()
public, private_swe, private_context, checks = [], [], [], []
for item in selection:
    row = contexts[item['id']] if item['dataset']=='contextbench' else swe[item['id']]
    assert row['base_commit']==item['base_commit'] and row['repo']==item['repo']
    public.append({**{key:item[key] for key in ['dataset','id','language','split','repo','base_commit']},'problem_statement':row['problem_statement'],'transport_verification':'original_parquet_sha256_verified'})
    fields = {**item,'problem_statement_present':bool(row['problem_statement']),'patch_present':bool(row['patch']),'test_patch_present':bool(row['test_patch'])}
    if item['dataset']=='contextbench':
        gold = json.loads(row['gold_context'])
        def parse_tests(value):
            try:return json.loads(value)
            except json.JSONDecodeError:return ast.literal_eval(value)
        fields.update(gold_span_count=len(gold),gold_distinct_files=len({x['file'] for x in gold}),gold_span_keys=sorted({key for span in gold for key in span}),f2p_count=len(parse_tests(row['f2p'])),p2p_count=len(parse_tests(row['p2p'])))
        private_context.append(row)
    else:
        fields.update(f2p_count=len(row['FAIL_TO_PASS']),p2p_count=len(row['PASS_TO_PASS']),image=row['image'],log_parser=row['log_parser'],eval_type=row['eval_type'],eval_script_present=bool(row['eval_script']))
        private_swe.append(row)
    checks.append(fields)
dump_lines('public-tasks.jsonl',public)
dump_lines('private-selected-swe-records.jsonl',private_swe)
dump_lines('private-selected-context-records.jsonl',private_context)
pq.write_table(pa.Table.from_pylist(private_context,schema=context_table.schema),PRIVATE/'selected-context-official-schema.parquet')
(PRIVATE/'selected-field-checks.json').write_text(json.dumps(checks,indent=2),encoding='utf8')
print(json.dumps({'public_tasks':len(public),'swe_records':len(private_swe),'context_records':len(private_context),'context_empty_f2p':[x['id'] for x in checks if x['dataset']=='contextbench' and not x['f2p_count']],'context_empty_gold':[x['id'] for x in checks if x['dataset']=='contextbench' and not x['gold_span_count']]}))
