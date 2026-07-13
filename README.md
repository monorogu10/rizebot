# Rizebot Ethergeon

## Discord slash commands

Slash command didaftarkan otomatis saat bot ready. Command prefix Discord `!` sudah dinonaktifkan; seluruh interaksi user memakai `/`.

- `/register gamertag:<nama>` membuat atau melanjutkan registrasi.
- `/status [user]` menampilkan Ethergeon ID Card; target user lain khusus admin/interviewer.
- `/player nama:<gamertag>` mencari data player dengan autocomplete player online/registry.
- `/interview accept|reject|close|status|doctor|repair|relink|compile|archive` mengelola interview.
- `/registry list|sync|set-gamertag` menampilkan dan memperbaiki registry.
- `/help` menampilkan command finance, UU, moderasi, shop, Minecraft bridge, dan topup sesuai akses user.

## Minecraft server log

Chat, join/leave, kematian player, lifecycle/restart, command attempt, transparansi, security alert, dan error script behavior pack dikirim melalui event bridge yang memakai ID unik, persistent queue, retry, serta deduplikasi. Rizebot menyimpan event ke `.runtime/minecraft-event-outbox.json` sebelum mengirimnya ke Discord, sehingga gangguan Discord tidak langsung menghilangkan log.

Channel dapat dipisahkan melalui `.env` berikut. Semua channel tambahan otomatis memakai chatlog utama sebagai fallback jika belum diisi.

```env
MINECRAFT_CHAT_LOG_CHANNEL_ID=1519260589208240219
MINECRAFT_AUDIT_LOG_CHANNEL_ID=
MINECRAFT_ERROR_LOG_CHANNEL_ID=
MINECRAFT_ORGANIZATION_LOG_CHANNEL_ID=
```

- Chat umum, presence, death, dan system message masuk ke chatlog utama.
- Transparansi, blocked chat, dan command attempt masuk ke audit log.
- Error/fatal script masuk ke error log.
- Chat organisasi masuk ke organization log agar tidak bercampur dengan chat umum.
- `/minecraft status` menampilkan jumlah outbox tertunda, delivery sukses, dan percobaan delivery yang gagal.

Secara default command didaftarkan global. Untuk update instan selama development, isi `DISCORD_COMMAND_GUILD_IDS` dengan satu atau beberapa guild ID yang dipisahkan koma. Bot perlu diundang dengan scope `bot`/`applications.commands`.

## Rules dan Undang-Undang

Command publik:

- `/rules` membaca daftar item/entity terlarang langsung dari behavior pack Minecraft. Saat server offline, bot menampilkan snapshot terakhir dari SQLite/JSON.
- `/uu lihat` membuka daftar Undang-Undang Ethergeon.
- `/uu lihat pencarian:<nomor|kode|kata>` mencari UU berdasarkan nomor, kode, judul, atau isi.
- `/uu help` menampilkan tutorial UU lengkap di Discord.

Command admin UU:

- `/uu create catatan:<catatan awal>` membuat draft Pasal 1 Ayat (1).
- `/uu draft [id]` melanjutkan draft autosave melalui panel Discord.
- `/uu revise` membuka pemilih UU, lalu pemilih Pasal dan editor revisi.
- `/uu revise id:<nomor/kode> [alasan]` langsung menyiapkan revisi UU tersebut.
- `/uu cabut id:<nomor/kode> alasan:<alasan>` mencabut UU tanpa menghapus arsip.

Admin UU adalah pemilik ID admin utama, member dengan permission Administrator/Manage Server, atau role dalam environment variable `LAW_ADMIN_ROLE_IDS` (pisahkan beberapa ID role dengan koma).

Data utama tersimpan di `data/rizebot.db`. Cadangan JSON otomatis berada di `data/laws.json` dan `data/rules-cache.json`. Jalankan `npm run db:export-json` untuk mengekspor ulang seluruh mirror JSON dan `npm run db:backup` untuk backup SQLite.

### Tutorial membuat UU

1. Jalankan `/uu create catatan:<isi Ayat pertama>`. Bot membuat Draft Pasal 1 Ayat (1).
2. Di editor, gunakan **Judul UU** dan **Judul Pasal** untuk merapikan nama dokumen.
3. Gunakan **Tambah Ayat** pada Pasal yang sedang terbuka atau **Tambah Pasal** untuk membuat Pasal berikutnya.
4. Periksa seluruh Pasal dengan tombol navigasi dan **Preview**.
5. Tekan **Terbitkan UU**, lalu ketik `TERBITKAN`. Bot membuat backup sebelum memberi nomor resmi.
6. Jika editor ditutup atau kedaluwarsa, lanjutkan dengan `/uu draft id:<ID draft>`; semua perubahan sebelumnya sudah tersimpan.

### Tutorial merevisi UU

1. Jalankan `/uu revise`, pilih UU, kemudian pilih Pasal yang ingin dibuka. ID UU dapat diisi langsung pada option `id`.
2. Isi alasan revisi. Bot menyalin versi publik menjadi draft baru; versi publik lama tetap berlaku dan tidak berubah.
3. Pada Pasal terpilih, gunakan **Tambah Ayat**, **Ubah Ayat**, atau **Cabut/Pulihkan**. Editor juga dapat menambah Pasal dan mengganti judul.
4. **Ubah Ayat** dan **Cabut/Pulihkan** meminta nomor Ayat serta alasan tindakan. Ayat yang dicabut tetap tersimpan dan ditandai, bukan dihapus dari riwayat.
5. Tekan **Lihat Perubahan** untuk memeriksa perbedaan dengan versi yang sedang berlaku.
6. Tekan **Terbitkan Revisi**, lalu ketik `TERBITKAN REVISI`. Baru pada tahap ini draft menjadi versi publik terbaru.
7. Gunakan `/uu draft id:<kode UU>` untuk melanjutkan draft revisi yang tertunda. Hanya satu draft revisi aktif yang diperbolehkan untuk setiap UU.
8. **Batalkan Revisi** menghapus draft kerja tetapi tidak mengubah versi publik. **Tutup Editor (Autosave)** hanya menutup panel dan mempertahankan draft.

Versi publik lama bersifat immutable dan tetap tersedia melalui navigasi riwayat pada `/uu lihat`. Notifikasi server dikirim hanya setelah penerbitan, bukan selama pengeditan draft.

## Interview registration recovery

Nomor interview dialokasikan atomik melalui tabel `interview_sessions`. Session direservasi sebelum channel Discord dibuat, sehingga spam `/register` tidak dapat membuat nomor/channel ganda.

Command admin/interviewer:

- `/interview accept [user] [gamertag] [force]`
- `/interview reject [user] [alasan] [force]`
- `/interview close [user] [force]`
- `/interview relink user:<user> [gamertag]`
- `/interview status [user]`
- `/interview doctor`
- `/interview repair mode:dry-run`
- `/interview repair mode:apply`

Command tanpa option user dapat dijalankan langsung di channel interview. Option `force:true` menampilkan panel konfirmasi yang hanya dapat diakses admin pemanggil; belum ada data yang berubah sebelum tombol konfirmasi ditekan. Isi `gamertag` wajib hanya bila record user memang sudah hilang.

Selalu jalankan mode `dry-run` dan periksa file laporan sebelum mode `apply` (dry-run berlaku 30 menit). Mode apply membuat backup SQLite terlebih dahulu, mempertahankan nomor channel canonical, memberikan nomor baru pada duplikat, menutup channel ganda milik user yang sama, serta memperbaiki mapping registry/session.
