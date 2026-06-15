import re, sys
from pathlib import Path

root = Path(sys.argv[1])
skip = {'localize_en.py', 'remaining_cn.txt', 'locale_audit.txt'}

user_files = []
internal_only = []

for p in root.rglob('*'):
    if not p.is_file() or p.name in skip:
        continue
    if p.suffix not in {'.js', '.mjs', '.css', '.html', '.md', '.txt', '.mdc', '.json'}:
        continue
    text = p.read_text(encoding='utf-8', errors='ignore')

    def decode(s):
        s = re.sub(r'\\u\{([0-9a-fA-F]+)\}', lambda m: chr(int(m.group(1), 16)), s)
        return re.sub(r'\\u([0-9a-fA-F]{4})', lambda m: chr(int(m.group(1), 16)), s)

    hits = set()
    for m in re.finditer(r'[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+', text):
        hits.add(m.group())
    for m in re.finditer(r'(?:\\u[0-9a-fA-F]{4}){2,}', text):
        d = decode(m.group())
        if re.search(r'[\u4e00-\u9fff\u3040-\u30ff]', d):
            hits.add(d[:120])

    if not hits:
        continue

    rel = str(p.relative_to(root))
    sample = sorted(hits)[:6]
    zod_markers = ('无效', '無効', '入力', '文字', '要素', '配列', '預期', '字串', '鍵', '數值', '項目', '擁有', '位元', '無法', '字元', '字节', '包含', '电子邮件', '表情', '日期', '时间', '时长', '地址', '网段', '编码', '号码', '数字', '数组', '空值', '输入', '数值', '应', '個', '開頭', '結尾', '必須', '倍數', '群', '値', '絵', '日時', '日付', '時刻', '期間', '範囲', '番号', '数値', '配列', '以下', 'より', '大き', '小さ', '必要', '無効', '選択', '文字列', '認識', '鍵値', '輸入', '郵件', '編碼', '字串', '數值', '選項', '出現', '中的', '内の', '内の無効')

    if p.name == 'mcp-server.mjs':
        internal_only.append((rel, len(hits), sample))
    elif p.suffix == '.css':
        internal_only.append((rel, len(hits), sample))
    elif p.name == 'localize_en.py':
        internal_only.append((rel, len(hits), sample))
    else:
        user_files.append((rel, len(hits), sample))

print('USER_FACING:', len(user_files))
for rel, n, sample in user_files:
    print(f'  {rel} ({n}): {sample}')
print('INTERNAL:', len(internal_only))
for rel, n, sample in internal_only:
    print(f'  {rel} ({n}): {sample[:3]}')
