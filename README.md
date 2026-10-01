# なないろ菜・マイクロハーブ 受発注システム

## 画面のURL

| 画面 | URL | 使う人 |
|---|---|---|
| 注文画面 | https://n-sketch-r.github.io/nanairo-app/ | お客様（LINEのミニアプリから開きます） |
| 管理画面 | https://n-sketch-r.github.io/nanairo-app/admin.html | スタッフ（パスワードが必要です） |

## ファイルの中身

- `index.html` … 注文画面
- `admin.html` … 管理画面
- `gas/Code.gs` … Google Apps Script（GAS）の保管用の写し。実際に動いているのはGASのエディタの中のコードです
- `images/` … 商品写真とロゴ

## 大事な約束

- LINEのトークンやパスワードは、このリポジトリに書かないでください（GASの「スクリプトプロパティ」にだけ保存します）。
- `main` に入れた変更は、すぐに本番の画面に反映されます。
