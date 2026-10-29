# Deploy FaStream Web (Cloudflare Worker)

1. `npm i -g wrangler` lalu `wrangler login`
2. Ubah `name` di `wrangler.toml` (mis. "stream").
3. Set kunci penanda-tangan (isi bebas, acak & panjang):
   `wrangler secret put SIGN_KEY`
4. `wrangler deploy`

Buka `https://<name>.<akun>.workers.dev` — halaman statis dari folder `public/`,
resolver di `/api/resolve`, proxy media di `/api/proxy`.

Bila index.html di-host di tempat lain, tambahkan sebelum script lain:
`<script>window.FASTREAM_API = 'https://<name>.<akun>.workers.dev'</script>`

Update data anime: ganti `public/data.js` (hasil tools/build_data.py), deploy ulang.
