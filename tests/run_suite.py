#!/usr/bin/env python3
"""ユニットテストを実行し、収集件数が下限を割ったら失敗させる。

unittest は 1 件も集まらなくても「成功」を返す。テストファイルが消えても、
命名規則から外れても、import に失敗しても CI が緑になるため、件数の下限を
ここで見る。テストの失敗と「テストが無い」ことを、どちらも exit 1 に揃える。

モジュールを名指しせず discover を使うのは、逆向きの穴を開けないため。
名指しにすると tests/ にテストを足しても走らず、落ちるテストを追加したのに
CI が緑になる。下限だけでは「決め打ちしたファイルの中の件数」しか数えない。

下限は現在の件数より少し低く置く。テストの統合で数件減るのは正常だが、
クラスごと消えるような減り方は事故なので、そこで落とす。
"""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

MINIMUM = 60


def main():
    # top_level_dir を tests/ 自身にする。ROOT にすると discover が tests/ を
    # パッケージとして import しようとし、__init__.py が無いため ImportError になる。
    # import に失敗したファイルも _FailedTest として数に入るため、下限検査で捕まる
    tests = str(ROOT / "tests")
    suite = unittest.defaultTestLoader.discover(start_dir=tests, top_level_dir=tests)
    count = suite.countTestCases()
    print(f"collected {count} tests from tests/ (minimum {MINIMUM})")
    if count < MINIMUM:
        print(
            f"statusline: expected at least {MINIMUM} tests, collected {count}",
            file=sys.stderr,
        )
        return 1
    return 0 if unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())
