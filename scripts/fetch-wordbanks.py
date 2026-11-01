"""下载词库原始数据。

用法（在项目根目录执行）：
    python scripts/fetch-wordbanks.py

产物落在 scripts/raw/ 下，已被 .gitignore 忽略，不需要提交。
下载完成后执行 scripts/build-wordbanks.py 生成 data/wordbanks/*.js。

数据来源：
  ECDICT               https://github.com/skywind3000/ECDICT            （词条、音标、释义、词频）
  english-vocabulary   https://github.com/KyleBing/english-vocabulary   （短语例句）
  ipa-dict             https://github.com/open-dict-data/ipa-dict       （英式 / 美式音标）
"""

import os
import sys
import urllib.parse
import urllib.request

RAW_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'raw')

ECDICT_URL = 'https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv'

VOCAB_BASE = 'https://raw.githubusercontent.com/KyleBing/english-vocabulary/master/json/'
VOCAB_FILES = {
    'junior': '1-初中-顺序.json',
    'senior': '2-高中-顺序.json',
    'cet4': '3-CET4-顺序.json',
    'cet6': '4-CET6-顺序.json',
}

# 英美音标，一行一个词：word<TAB>/ipa/
IPA_BASE = 'https://raw.githubusercontent.com/open-dict-data/ipa-dict/master/data/'
IPA_FILES = {
    'ipa_en_UK.txt': 'en_UK.txt',
    'ipa_en_US.txt': 'en_US.txt',
}

# 需要代理时设置环境变量，例如：
#   HTTPS_PROXY=http://127.0.0.1:7890 python scripts/fetch-wordbanks.py
PROXY = os.environ.get('HTTPS_PROXY') or os.environ.get('https_proxy') or ''


def build_opener():
    if not PROXY:
        return urllib.request.build_opener()
    print(f'使用代理 {PROXY}')
    return urllib.request.build_opener(
        urllib.request.ProxyHandler({'http': PROXY, 'https': PROXY})
    )


def download(opener, url, dest, min_size):
    if os.path.exists(dest) and os.path.getsize(dest) >= min_size:
        print(f'跳过 {os.path.basename(dest)}（已存在）')
        return
    print(f'下载 {os.path.basename(dest)} ...')
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with opener.open(req, timeout=300) as resp:
        data = resp.read()
    if len(data) < min_size:
        raise RuntimeError(f'{dest} 只有 {len(data)} 字节，可能下载失败')
    with open(dest, 'wb') as f:
        f.write(data)
    print(f'  完成 {len(data) / 1048576:.1f} MB')


def main():
    os.makedirs(RAW_DIR, exist_ok=True)
    opener = build_opener()

    download(opener, ECDICT_URL, os.path.join(RAW_DIR, 'ecdict.csv'), 10 * 1024 * 1024)

    for bank, name in VOCAB_FILES.items():
        url = VOCAB_BASE + urllib.parse.quote(name)
        download(opener, url, os.path.join(RAW_DIR, bank + '.json'), 500 * 1024)

    for local, remote in IPA_FILES.items():
        download(opener, IPA_BASE + remote, os.path.join(RAW_DIR, local), 1000 * 1024)

    print('\n完成。接着执行：python scripts/build-wordbanks.py')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'失败：{error}', file=sys.stderr)
        sys.exit(1)
