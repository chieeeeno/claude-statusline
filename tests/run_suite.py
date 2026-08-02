#!/usr/bin/env python3
"""ユニットテストを実行し、収集件数が下限を割ったら失敗させる。

unittest は 1 件も集まらなくても「成功」を返す。テストファイルが消えても、
命名規則から外れても、import に失敗しても CI が緑になるため、件数の下限を
ここで見る。テストの失敗と「テストが無い」ことを、どちらも exit 1 に揃える。

下限は現在の件数より少し低く置く。テストの統合で数件減るのは正常だが、
クラスごと消えるような減り方は事故なので、そこで落とす。
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

MODULE = "tests.test_statusline"
MINIMUM = 60


def main():
    suite = unittest.defaultTestLoader.loadTestsFromName(MODULE)
    count = suite.countTestCases()
    print(f"collected {count} tests from {MODULE} (minimum {MINIMUM})")
    if count < MINIMUM:
        # import 失敗も _FailedTest 1 件として現れるので、ここで一緒に捕まる
        print(
            f"statusline: expected at least {MINIMUM} tests, collected {count}",
            file=sys.stderr,
        )
        return 1
    return 0 if unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())
