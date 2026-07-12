# Rizebot Ethergeon

## Rules dan Undang-Undang

Command publik:

- `!rules` membaca daftar item/entity terlarang langsung dari behavior pack Minecraft. Saat server offline, bot menampilkan snapshot terakhir dari SQLite/JSON.
- `!uu` membuka daftar Undang-Undang Ethergeon.
- `!uu <nomor|kode|kata>` mencari UU berdasarkan nomor, kode, judul, atau isi.

Command admin UU:

- `!create-uu <catatan awal>` membuat draft Pasal 1 Ayat (1).
- `!draft-uu [ID]` atau `!edit-uu [ID]` melanjutkan draft melalui panel Discord.
- `!revise-uu <nomor/kode> | <catatan>` membuat versi revisi baru.
- `!cabut-uu <nomor/kode> | <alasan>` mencabut UU tanpa menghapus arsip.

Admin UU adalah pemilik ID admin utama, member dengan permission Administrator/Manage Server, atau role dalam environment variable `LAW_ADMIN_ROLE_IDS` (pisahkan beberapa ID role dengan koma).

Data utama tersimpan di `data/rizebot.db`. Cadangan JSON otomatis berada di `data/laws.json` dan `data/rules-cache.json`. Jalankan `npm run db:export-json` untuk mengekspor ulang seluruh mirror JSON dan `npm run db:backup` untuk backup SQLite.

## Interview registration recovery

Nomor interview dialokasikan atomik melalui tabel `interview_sessions`. Session direservasi sebelum channel Discord dibuat, sehingga spam `!reg` tidak dapat membuat nomor/channel ganda.

Command admin/interviewer:

- `!accept [@user]` atau `!accept --force @user [gamertag]`
- `!reject [@user] [alasan]` atau `!reject --force @user [alasan]`
- `!close [@user]` atau `!close --force @user`
- `!relink-interview @user [gamertag]`
- `!interview-status [@user]`
- `!interview-doctor`
- `!repair-interviews --dry-run`
- `!repair-interviews --apply`

Command tanpa mention dapat dijalankan langsung di channel interview. Mode `--force` menampilkan panel konfirmasi yang hanya dapat diakses admin pemanggil; belum ada data yang berubah sebelum tombol konfirmasi ditekan. Isi `gamertag` wajib hanya bila record user memang sudah hilang.

Selalu jalankan `--dry-run` dan periksa file laporan sebelum `--apply` (dry-run berlaku 30 menit). Mode apply membuat backup SQLite terlebih dahulu, mempertahankan nomor channel canonical, memberikan nomor baru pada duplikat, menutup channel ganda milik user yang sama, serta memperbaiki mapping registry/session.
