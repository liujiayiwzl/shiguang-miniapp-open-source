"""把 ECDICT + 词库短语合成为小程序用的词库文件。

用法（在项目根目录执行，需先跑 fetch-wordbanks.py）：
    python scripts/build-wordbanks.py

输出 packageWords/data/wordbanks/{junior,senior,cet4,cet6}.js，
每个文件是一整条字符串，按行（\\n）分条、按竖线（|）分字段：

    "ability|/əˈbɪləti/|/əˈbɪləti/|n. 能力，才能|innovation ability|创新能力\nable|..."

字段依次是：单词|英音|美音|释义|例句|例句翻译

为什么用字符串而不是数组/对象：
  - 对象每条要多带 word/phonetic/meaning 这些键名，一万四千条下来多占几百 KB
  - 数组要带引号和逗号，也要多占一百多 KB
  - 字符串只保留内容本身 + 一个分隔符，压缩后差距更大
词库放分包（packageWords）是因为全量约 1.2MB，主包上限只有 2MB，
放主包会把首页一起拖慢。

选词策略：
  1. 按 ECDICT 的 tag 字段分库（zk=中考 gk=高考 cet4 cet6）
  2. 去掉 the/and/of 这类虚词，背单词不该从冠词开始
  3. 本库独有的词排前面（例如六级优先出现 cet6 有、cet4 没有的词），
     再排与低阶词库共有的词，避免四个库开头一模一样
  4. 组内按词频从高到低，先学常用的

音标来源：
  ECDICT 自带一个 phonetic 字段，只有一套读音，作为兜底；
  英式、美式分别取自 ipa-dict 的 en_UK / en_US，再做一轮清洗
  （重音位置、长音符、ɹ/ɝ/ɚ 等写法统一成教材习惯）。
"""

import csv
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
RAW_DIR = os.path.join(HERE, 'raw')
OUT_DIR = os.path.join(os.path.dirname(HERE), 'packageWords', 'data', 'wordbanks')

# None = 全量收录。ECDICT 过滤后四个库分别约 1500 / 3500 / 3800 / 5400 词。
LIMIT = None

# bank_id, tag, 中文名, 低一阶的 tag（用来判断「本库独有」）
BANKS = [
    ('junior', 'zk', '初中', None),
    ('senior', 'gk', '高中', 'zk'),
    ('cet4', 'cet4', '四级', 'gk'),
    ('cet6', 'cet6', '六级', 'cet4'),
]

# 虚词黑名单：词频极高但没有记忆价值
STOPWORDS = set("""
a an the and or but if of in on at to for from with by as is am are was were be been being
have has had do does did will would can could shall should may might must
i you he she it we they me him her us them my your his its our their
this that these those there here not no nor so than then too very just also
up down out off over under again more most some any all both each every other another
such own same only what which who whom whose when where why how
one two three four five six seven eight nine ten first second third
mr mrs ms dr ok yes oh ah
""".split())

# 释义里混进来的领域标记
DOMAIN_TAG = re.compile(r'\[[^\]]{1,8}\]')
# 变位/人名等不适合当词条
BAD_TRANS = re.compile(r'人名|地名|姓氏|复数|过去式|过去分词|现在分词|比较级|最高级|缩写|的过去式')
# 词性前缀，如 "vt." "adj." "a."
POS_PREFIX = re.compile(r'^((?:n|v|vt|vi|adj|adv|prep|conj|pron|num|art|int|aux|abbr|a|ad)\.)\s*', re.I)
# 释义切分：中英文分号、逗号、顿号都算分隔符
SPLIT_ITEMS = re.compile(r'[；;，,、]')
# 例句里残留的装饰符号
LEADING_JUNK = re.compile(r'^[◎●○★☆※◆■□▲△·\-—–\s]+')

HEADER = """// 词库数据，请勿手工编辑。
// 由 scripts/build-wordbanks.py 生成，原始数据来自：
//   ECDICT             https://github.com/skywind3000/ECDICT
//   english-vocabulary https://github.com/KyleBing/english-vocabulary
//   ipa-dict           https://github.com/open-dict-data/ipa-dict
// 一整条字符串，按换行分条、按竖线分字段：单词|英音|美音|释义|例句|例句翻译
// 用字符串而不是数组/对象是为了省体积，解析见 packageWords/utils/wordbank.js
"""


def clean_text(raw):
    """去掉控制字符和零宽字符，避免渲染出空方块。"""
    if not raw:
        return ''
    text = re.sub(r'[\x00-\x1f\x7f\u200b-\u200f\ufeff]', ' ', raw)
    return re.sub(r'\s+', ' ', text).strip()


def clean_translation(raw):
    """ECDICT 的 translation 多行、每行逗号罗列一长串同义词。

    目标是压成「词性 + 两三个核心义项」，最多两行：
      "vt. 说, 讲, 念..." / "vi. 说, 讲"  ->  "vt. 说，讲"
    """
    if not raw:
        return ''

    raw = clean_text(raw)
    seen_items = []
    out_parts = []

    for line in raw.split('\\n')[:2]:
        line = DOMAIN_TAG.sub('', line).strip()
        if not line or BAD_TRANS.search(line):
            continue

        pos = ''
        m = POS_PREFIX.match(line)
        if m:
            pos = m.group(1).lower()
            line = line[m.end():]

        items = []
        for chunk in SPLIT_ITEMS.split(line):
            item = chunk.strip().strip('.．。 ').strip()
            if not item:
                continue
            # 和已收录的义项重复（或互相包含）就跳过
            if any(item == old or item in old for old in seen_items):
                continue
            items.append(item)
            seen_items.append(item)
            if len(items) >= 3:
                break

        if not items:
            continue

        text = '，'.join(items)
        if len(items) >= 3:
            text += '…'
        out_parts.append((pos + ' ' + text).strip())

    result = '；'.join(out_parts)
    result = re.sub(r'\s+', ' ', result).strip()

    if len(result) > 34:
        result = result[:33].rstrip('；，, 、') + '…'

    return result


def clean_example_cn(raw):
    """例句翻译去掉开头残留的装饰符号。"""
    if not raw:
        return ''
    text = LEADING_JUNK.sub('', clean_text(raw)).strip()
    text = DOMAIN_TAG.sub('', text).strip()
    if len(text) > 26:
        text = text[:25].rstrip('；，, 、') + '…'
    return text


def normalize_phonetic(raw):
    """ECDICT 有些音标用西里尔字母 ә，重音符用 '，统一成国际音标写法。"""
    if not raw:
        return ''
    text = clean_text(raw)
    text = text.replace('\u04d9', '\u0259')  # ә -> ə
    text = text.replace(':', '\u02d0')       # : -> ː
    text = text.replace("'", '\u02c8')       # ' -> ˈ
    text = re.sub(r'\s+', ' ', text)
    if not text.startswith('/'):
        text = '/' + text
    if not text.endswith('/'):
        text = text + '/'
    return text


# ---------------- 英美音标清洗 ----------------
# ipa-dict 的两个文件各有系统性偏差，这里统一修掉：
#   英式把重音贴在元音正前方（/kəmpjˈuːtɐ/），要挪回音节开头
#   美式缺长音符，且 ɝ/ɚ 不区分轻重读

STRESS_MARKS = ('\u02c8', '\u02cc')  # ˈ ˌ
# 元音符号（不含长音符 ː）
NUCLEI = set('aeiouɑæʌəɛɜɐɒɔʊɪɝɚɞɨʉɯɵɘɷɶøœ')
VOWEL_CHARS = NUCLEI | {'ː'}
# 双元音按一个音节算，判断单音节词时先合并掉
DIPHTHONGS = ['aɪ', 'aʊ', 'eɪ', 'oʊ', 'ɔɪ', 'ɪə', 'eə', 'ʊə', 'əʊ', 'ɛə', 'ɑɪ', 'ɑʊ', 'ɪʊ']
# 英语里合法的音节首，用来决定重音符最多能往左挪几格
ONSETS = set("""
p b t d k g f v θ ð s z ʃ ʒ h m n l r w j
pr br tr dr kr gr fr θr ʃr pl bl kl gl fl sl
sp st sk sm sn sw tw dw kw gw hj mj bj pj fj vj kj gj nj lj
spj stj skj str spr skr spl skw
""".split())


def move_stress(text):
    """把贴在元音前的重音符挪到音节开头。

    ipa-dict 英式写 /kəmpjˈuːtɐ/，教材写 /kəmˈpjuːtə/。
    往左挪的时候只能挪到合法音节首，不能把上一个音节的韵尾一起带过来，
    否则 computer 会变成 /kəˈmpjuːtə/。
    """
    chars = list(text)

    for i in range(len(chars)):
        if chars[i] not in STRESS_MARKS:
            continue
        nxt = chars[i + 1] if i + 1 < len(chars) else ''
        # 后面紧跟辅音，说明重音已经在音节开头，不用动
        if nxt and nxt not in VOWEL_CHARS:
            continue

        start = i
        while start > 0 and chars[start - 1] not in VOWEL_CHARS and chars[start - 1] not in STRESS_MARKS:
            start -= 1

        cluster = ''.join(chars[start:i])
        move = 0
        for length in range(min(3, len(cluster)), 0, -1):
            if cluster[-length:] in ONSETS:
                move = length
                break

        if move:
            chars.insert(i - move, chars.pop(i))

    return ''.join(chars)


def pick_variant(raw):
    """一个词可能给好几个读音，挑弱化最少的那个。

    image 会给 /ˈɪmədʒ/, /ˈɪmɪdʒ/，教材写的是后者；
    按「非弱元音最多」挑，就能避开把 ɪ 读成 ə 的弱化写法。
    """
    parts = [part.strip() for part in raw.split(',') if part.strip()]

    if not parts:
        return ''

    best, best_score = parts[0], -1

    for part in parts:
        score = sum(1 for ch in part if ch in NUCLEI and ch != 'ə')
        if score > best_score:
            best, best_score = part, score

    return best


def syllable_count(text):
    merged = text
    for diphthong in DIPHTHONGS:
        merged = merged.replace(diphthong, 'V')
    return sum(1 for ch in merged if ch in NUCLEI or ch == 'V')


def normalize_ipa(raw, dialect):
    """把 ipa-dict 的读音整成教材写法，返回带斜杠的音标。"""
    if not raw:
        return ''

    text = pick_variant(raw).strip('/').strip()

    if not text:
        return ''

    # ɹ(浊卷舌近音) / ɡ(单层 g) / ɫ(暗 l) 统一成教材用的 r g l
    text = text.replace('ɹ', 'r').replace('ɡ', 'g').replace('ɫ', 'l')
    text = text.replace('ɛ', 'e')
    text = move_stress(text)

    out = []
    stressed = False

    for i, ch in enumerate(text):
        nxt = text[i + 1] if i + 1 < len(text) else ''

        if ch in STRESS_MARKS:
            stressed = True
            out.append(ch)
            continue

        if ch not in VOWEL_CHARS:
            out.append(ch)
            continue

        is_stressed, stressed = stressed, False
        # 后面还跟着元音说明这是双元音的一部分（əʊ / ɪə / aɪ …），
        # 不能按「重读的 ə 就是 ʌ」去改，否则 program 会变成 /ˈprʌʊgræm/
        in_diphthong = bool(nxt) and nxt in VOWEL_CHARS

        # ɐ 是英式源里的「阿」音，重读时其实是 ʌ，轻读时是 ə
        if ch == 'ɐ':
            ch = ('ʌ' if is_stressed else 'ə') if not in_diphthong else 'ə'
        # 带重音符的 ə 在英语里不存在，实际是 ʌ
        elif ch == 'ə' and is_stressed and not in_diphthong:
            ch = 'ʌ'
        # ɝ 是重读的卷舌元音，ɚ 是轻读的
        elif ch == 'ɝ':
            ch = 'ɜːr' if is_stressed else 'ər'
        elif ch == 'ɚ':
            ch = 'ər'

        # 美式源不带长音符，这里补：不在词尾、后面也不跟元音时才加
        if dialect == 'us' and ch in 'iuɑɔɜ' and nxt and nxt != 'ː' and nxt not in VOWEL_CHARS:
            ch += 'ː'

        out.append(ch)

    result = re.sub('ː{2,}', 'ː', ''.join(out))

    # 单音节词不标重音，教材写法就是 /kɑː/ 而不是 /ˈkɑː/
    if syllable_count(result) <= 1:
        for mark in STRESS_MARKS:
            result = result.replace(mark, '')

    return '/' + result + '/'


def looks_like_ipa(text):
    """ECDICT 有少量音标其实是拼写（put -> put），这种不如直接用另一边的读音。"""
    return bool(re.search(r'[ˈˌːɑɒɔəɜɪʊʌæʃʒθðŋɝɚ]', text))


def load_ipa(filename):
    """读 ipa-dict 的 word\\t/ipa/ 格式，返回 {小写单词: 原始音标}。"""
    path = os.path.join(RAW_DIR, filename)

    if not os.path.exists(path):
        print(f'缺少 scripts/raw/{filename}，英美音标会退回 ECDICT 的单套音标', file=sys.stderr)
        return {}

    table = {}

    with open(path, encoding='utf-8') as f:
        for line in f:
            line = line.rstrip('\n')

            if not line:
                continue

            parts = line.split('\t')

            if len(parts) < 2:
                continue

            key = parts[0].strip().lower()

            if key and key not in table:
                table[key] = parts[1].strip()

    return table


def load_phrases():
    """从 english-vocabulary 的 json 里取第一个短语当例句。"""
    table = {}
    for name in ['junior', 'senior', 'cet4', 'cet6']:
        p = os.path.join(RAW_DIR, name + '.json')
        if not os.path.exists(p):
            continue
        with open(p, encoding='utf-8') as f:
            data = json.load(f)
        for item in data:
            word = (item.get('word') or '').strip().lower()
            phrases = item.get('phrases') or []
            if not word or not phrases or word in table:
                continue
            first = phrases[0]
            ph = (first.get('phrase') or '').strip()
            tr = (first.get('translation') or '').strip()
            if ph and tr and len(ph) <= 38 and len(tr) <= 26:
                table[word] = (ph, tr)
    return table


def main():
    ecdict = os.path.join(RAW_DIR, 'ecdict.csv')
    if not os.path.exists(ecdict):
        print('缺少 scripts/raw/ecdict.csv，先执行 python scripts/fetch-wordbanks.py', file=sys.stderr)
        sys.exit(1)

    phrases = load_phrases()
    print(f'短语表 {len(phrases)} 条')

    ipa_uk = load_ipa('ipa_en_UK.txt')
    ipa_us = load_ipa('ipa_en_US.txt')
    print(f'英式音标 {len(ipa_uk)} 条，美式音标 {len(ipa_us)} 条')

    rows = {bank: [] for bank, _, _, _ in BANKS}

    with open(ecdict, encoding='utf-8', newline='') as f:
        reader = csv.DictReader(f)
        for row in reader:
            word = (row.get('word') or '').strip()
            tags = (row.get('tag') or '').split()
            if not word or not tags:
                continue
            if not re.fullmatch(r"[A-Za-z][A-Za-z'\-]{1,24}", word):
                continue
            if word.lower() in STOPWORDS:
                continue

            meaning = clean_translation(row.get('translation'))
            if not meaning:
                continue

            phonetic = normalize_phonetic(row.get('phonetic'))
            key = word.lower()

            # 英式、美式各取各的；缺了先看 ECDICT 那套像不像音标，再退回另一边
            uk = normalize_ipa(ipa_uk.get(key, ''), 'uk')
            us = normalize_ipa(ipa_us.get(key, ''), 'us')

            if not uk:
                uk = phonetic if looks_like_ipa(phonetic) else us
            if not us:
                us = phonetic if looks_like_ipa(phonetic) else uk

            # 两套音标都没有的词才跳过，卡片上会空一块
            if not uk or not us:
                continue

            try:
                frq = int(row.get('frq') or 0)
            except ValueError:
                frq = 0

            for bank, tag, _, lower in BANKS:
                if tag not in tags:
                    continue
                # 本库独有：有本库 tag，且没有低一阶的 tag
                specific = 0 if (lower is None or lower not in tags) else 1
                rows[bank].append({
                    'word': word,
                    'phoneticUk': uk,
                    'phoneticUs': us,
                    'meaning': meaning,
                    'frq': frq,
                    'specific': specific,
                })

    os.makedirs(OUT_DIR, exist_ok=True)
    summary = []

    for bank, _, label, _lower in BANKS:
        items = rows[bank]
        # 本库独有优先 → 高频优先 → 字母序兜底（保证结果稳定可复现）
        items.sort(key=lambda x: (
            x['specific'],
            x['frq'] <= 0,
            x['frq'] if x['frq'] > 0 else 0,
            x['word'].lower(),
        ))

        seen = set()
        uniq = []
        for it in items:
            key = it['word'].lower()
            if key in seen:
                continue
            seen.add(key)
            uniq.append(it)

        total_available = len(uniq)
        specific_count = sum(1 for it in uniq if it['specific'] == 0)
        kept = uniq if LIMIT is None else uniq[:LIMIT]

        lines = []
        for it in kept:
            ph, tr = phrases.get(it['word'].lower(), ('', ''))
            fields = [
                it['word'],
                it['phoneticUk'],
                it['phoneticUs'],
                it['meaning'],
                ph,
                clean_example_cn(tr),
            ]
            # 分隔符冲突直接报错，免得悄悄生成坏数据
            for field in fields:
                if '|' in field or '\n' in field or '\r' in field:
                    raise ValueError(f'字段里出现分隔符：{field!r}')
            lines.append('|'.join(fields))

        payload = '\n'.join(lines)
        body = HEADER + 'module.exports = ' + json.dumps(payload, ensure_ascii=False) + '\n'
        dest = os.path.join(OUT_DIR, bank + '.js')
        with open(dest, 'w', encoding='utf-8', newline='\n') as f:
            f.write(body)
        size = os.path.getsize(dest)
        summary.append((bank, label, total_available, len(kept), size))
        print(f'{bank:7s} {label}  可选 {total_available:5d}（本库独有 {specific_count:4d}）'
              f'  收录 {len(kept):4d}  {size / 1024:6.1f} KB')

    print('\n合计 %.1f KB' % (sum(s[4] for s in summary) / 1024))


if __name__ == '__main__':
    main()
