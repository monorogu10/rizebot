# Rizebot Ethergeon

## Rules dan Undang-Undang

Command publik:

- `!rules` membaca daftar item/entity terlarang langsung dari behavior pack Minecraft. Saat server offline, bot menampilkan snapshot terakhir dari SQLite/JSON.
- `!uu` membuka daftar Undang-Undang Ethergeon.
- `!uu <nomor|kode|kata>` mencari UU berdasarkan nomor, kode, judul, atau isi.
- `!uu-help` atau `!uu tutorial` menampilkan tutorial UU lengkap di Discord.

Command admin UU:

- `!create-uu <catatan awal>` membuat draft Pasal 1 Ayat (1).
- `!draft-uu [ID/kode]` atau `!edit-uu [ID/kode]` melanjutkan draft autosave melalui panel Discord.
- `!revise-uu` membuka pemilih UU, lalu pemilih Pasal dan editor revisi.
- `!revise-uu <nomor/kode>` langsung membuka pemilih Pasal untuk UU tersebut.
- `!revise-uu <nomor/kode> | <alasan>` menyiapkan alasan revisi sebelum memilih Pasal.
- `!cabut-uu <nomor/kode> | <alasan>` mencabut UU tanpa menghapus arsip.

Admin UU adalah pemilik ID admin utama, member dengan permission Administrator/Manage Server, atau role dalam environment variable `LAW_ADMIN_ROLE_IDS` (pisahkan beberapa ID role dengan koma).

Data utama tersimpan di `data/rizebot.db`. Cadangan JSON otomatis berada di `data/laws.json` dan `data/rules-cache.json`. Jalankan `npm run db:export-json` untuk mengekspor ulang seluruh mirror JSON dan `npm run db:backup` untuk backup SQLite.

### Tutorial membuat UU

1. Jalankan `!create-uu <isi Ayat pertama>`. Bot membuat Draft Pasal 1 Ayat (1).
2. Di editor, gunakan **Judul UU** dan **Judul Pasal** untuk merapikan nama dokumen.
3. Gunakan **Tambah Ayat** pada Pasal yang sedang terbuka atau **Tambah Pasal** untuk membuat Pasal berikutnya.
4. Periksa seluruh Pasal dengan tombol navigasi dan **Preview**.
5. Tekan **Terbitkan UU**, lalu ketik `TERBITKAN`. Bot membuat backup sebelum memberi nomor resmi.
6. Jika editor ditutup atau kedaluwarsa, lanjutkan dengan `!edit-uu <ID draft>`; semua perubahan sebelumnya sudah tersimpan.

### Tutorial merevisi UU

1. Jalankan `!revise-uu`, pilih UU, kemudian pilih Pasal yang ingin dibuka. Alternatif: `!revise-uu UU-EG-2026-001`.
2. Isi alasan revisi. Bot menyalin versi publik menjadi draft baru; versi publik lama tetap berlaku dan tidak berubah.
3. Pada Pasal terpilih, gunakan **Tambah Ayat**, **Ubah Ayat**, atau **Cabut/Pulihkan**. Editor juga dapat menambah Pasal dan mengganti judul.
4. **Ubah Ayat** dan **Cabut/Pulihkan** meminta nomor Ayat serta alasan tindakan. Ayat yang dicabut tetap tersimpan dan ditandai, bukan dihapus dari riwayat.
5. Tekan **Lihat Perubahan** untuk memeriksa perbedaan dengan versi yang sedang berlaku.
6. Tekan **Terbitkan Revisi**, lalu ketik `TERBITKAN REVISI`. Baru pada tahap ini draft menjadi versi publik terbaru.
7. Gunakan `!edit-uu <kode UU>` untuk melanjutkan draft revisi yang tertunda. Hanya satu draft revisi aktif yang diperbolehkan untuk setiap UU.
8. **Batalkan Revisi** menghapus draft kerja tetapi tidak mengubah versi publik. **Tutup Editor (Autosave)** hanya menutup panel dan mempertahankan draft.

Versi publik lama bersifat immutable dan tetap tersedia melalui navigasi riwayat pada `!uu`. Notifikasi server dikirim hanya setelah penerbitan, bukan selama pengeditan draft.

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
