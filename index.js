const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

const app = express();
const port = process.env.PORT || 3000;

const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme';
const SESSION_SECRET = process.env.SESSION_SECRET || 'devsecret';

// Set up DB
const db = new sqlite3.Database(path.join(__dirname, 'comics.db'));
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS comics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      title TEXT,
      description TEXT,
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

// Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safe = Date.now() + '-' + file.originalname.replace(/\s+/g, '-');
    cb(null, safe);
  }
});
const upload = multer({ storage });

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
}));

// Helper to fetch a comic by id or newest
function getComicById(id, cb) {
  if (id === undefined || id === null) {
    db.get('SELECT * FROM comics ORDER BY id DESC LIMIT 1', [], cb);
  } else {
    db.get('SELECT * FROM comics WHERE id = ?', [id], (err, row) => cb(err, row));
  }
}

function getAdjacentIds(id, cb) {
  db.get('SELECT id FROM comics WHERE id < ? ORDER BY id DESC LIMIT 1', [id], (err, prevRow) => {
    if (err) return cb(err);
    db.get('SELECT id FROM comics WHERE id > ? ORDER BY id ASC LIMIT 1', [id], (err2, nextRow) => {
      if (err2) return cb(err2);
      cb(null, { prevId: prevRow ? prevRow.id : null, nextId: nextRow ? nextRow.id : null });
    });
  });
}

// Public routes
app.get('/', (req, res) => {
  getComicById(null, (err, comic) => {
    if (err) return res.status(500).send('DB error');
    res.render('index', { comic });
  });
});

app.get('/comic/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  getComicById(id, (err, comic) => {
    if (err) return res.status(500).send('DB error');
    if (!comic) return res.status(404).send('Comic not found');
    res.render('index', { comic });
  });
});

// Archive with pagination
app.get('/archive', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const perPage = 12;
  const offset = (page - 1) * perPage;

  db.get('SELECT COUNT(*) AS cnt FROM comics', [], (err, row) => {
    if (err) return res.status(500).send('DB error');
    const total = row.cnt || 0;
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    db.all('SELECT id, filename, title, description, uploaded_at FROM comics ORDER BY id DESC LIMIT ? OFFSET ?', [perPage, offset], (err2, rows) => {
      if (err2) return res.status(500).send('DB error');
      res.render('archive', { comics: rows, page, totalPages });
    });
  });
});

// Feeds
app.get('/comics.json', (req, res) => {
  db.all('SELECT id, filename, title, description, uploaded_at FROM comics ORDER BY id ASC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    const payload = rows.map(r => ({
      id: r.id,
      url: `${req.protocol}://${req.get('host')}/comic/${r.id}`,
      image: `${req.protocol}://${req.get('host')}/uploads/${r.filename}`,
      title: r.title,
      description: r.description,
      uploaded_at: r.uploaded_at
    }));
    res.json(payload);
  });
});

app.get('/rss.xml', (req, res) => {
  db.all('SELECT id, filename, title, description, uploaded_at FROM comics ORDER BY id DESC LIMIT 20', [], (err, rows) => {
    if (err) return res.status(500).send('DB error');
    const siteUrl = `${req.protocol}://${req.get('host')}`;
    const lastBuildDate = rows.length ? new Date(rows[0].uploaded_at).toUTCString() : new Date().toUTCString();

    let itemsXml = rows.map(r => {
      const title = r.title ? escapeXml(r.title) : `Comic #${r.id}`;
      const link = `${siteUrl}/comic/${r.id}`;
      const pubDate = new Date(r.uploaded_at).toUTCString();
      const imageUrl = `${siteUrl}/uploads/${r.filename}`;
      const description = escapeXml(`<img src="${imageUrl}" alt="${title}" /><p>${(r.description || '')}</p>`);
      return `\n  <item>\n    <title>${title}</title>\n    <link>${link}</link>\n    <guid isPermaLink="true">${link}</guid>\n    <pubDate>${pubDate}</pubDate>\n    <description><![CDATA[${description}]]></description>\n  </item>`;
    }).join('\n');

    const rss = `<?xml version="1.0" encoding="UTF-8" ?>\n<rss version="2.0">\n<channel>\n  <title>The adventures of Chad</title>\n  <link>${siteUrl}</link>\n  <description>Latest comics from The adventures of Chad</description>\n  <lastBuildDate>${lastBuildDate}</lastBuildDate>\n  ${itemsXml}\n</channel>\n</rss>`;

    res.set('Content-Type', 'application/rss+xml; charset=utf-8');
    res.send(rss);
  });
});

function escapeXml(unsafe) {
  return (unsafe || '').replace(/[<>&'\"]/g, function (c) {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
    }
  });
}

// API endpoints
app.get('/api/comics', (req, res) => {
  db.all('SELECT id, filename, title, description, uploaded_at FROM comics ORDER BY id ASC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json(rows);
  });
});

app.get('/api/comics/:id/adjacent', (req, res) => {
  const id = parseInt(req.params.id, 10);
  getAdjacentIds(id, (err, adj) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json(adj);
  });
});

// Admin auth middleware
function requireAdmin(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  res.redirect('/admin/login');
}

// Admin pages
app.get('/admin/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/admin/login', (req, res) => {
  const pass = req.body.password || '';
  if (pass === ADMIN_PASS) {
    req.session.loggedIn = true;
    res.redirect('/admin');
  } else {
    res.render('login', { error: 'Incorrect password' });
  }
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.get('/admin', requireAdmin, (req, res) => {
  db.all('SELECT id, filename, title, description, uploaded_at FROM comics ORDER BY id DESC', [], (err, rows) => {
    if (err) return res.status(500).send('DB error');
    res.render('admin', { comics: rows });
  });
});

// Upload new comic
app.post('/admin/upload', requireAdmin, upload.single('image'), (req, res) => {
  const file = req.file;
  const title = req.body.title || '';
  const description = req.body.description || '';
  if (!file) return res.status(400).send('No file uploaded');
  db.run('INSERT INTO comics (filename, title, description) VALUES (?, ?, ?)',
    [file.filename, title, description],
    function (err) {
      if (err) return res.status(500).send('DB insert error');
      res.redirect('/admin');
    });
});

// Edit comic form
app.get('/admin/edit/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.get('SELECT * FROM comics WHERE id = ?', [id], (err, row) => {
    if (err) return res.status(500).send('DB error');
    if (!row) return res.status(404).send('Not found');
    res.render('edit', { comic: row });
  });
});

// Update comic (title/description and optionally replace image)
app.post('/admin/edit/:id', requireAdmin, upload.single('image'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const title = req.body.title || '';
  const description = req.body.description || '';
  const file = req.file;

  db.get('SELECT filename FROM comics WHERE id = ?', [id], (err, row) => {
    if (err) return res.status(500).send('DB error');
    if (!row) return res.status(404).send('Not found');

    const updates = [];
    const params = [];

    if (file) {
      updates.push('filename = ?');
      params.push(file.filename);
    }
    updates.push('title = ?');
    updates.push('description = ?');
    params.push(title, description);
    params.push(id);

    db.run(`UPDATE comics SET ${updates.join(', ')} WHERE id = ?`, params, function (err2) {
      if (err2) return res.status(500).send('DB update error');

      // if replaced image, remove old file
      if (file && row.filename) {
        const oldPath = path.join(UPLOAD_DIR, row.filename);
        fs.unlink(oldPath, (unlinkErr) => {
          // ignore unlink errors
          res.redirect('/admin');
        });
      } else {
        res.redirect('/admin');
      }
    });
  });
});

// Delete comic
app.post('/admin/delete/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.get('SELECT filename FROM comics WHERE id = ?', [id], (err, row) => {
    if (err) return res.status(500).send('DB error');
    if (!row) return res.status(404).send('Not found');

    db.run('DELETE FROM comics WHERE id = ?', [id], function (err2) {
      if (err2) return res.status(500).send('DB delete error');

      const filePath = path.join(UPLOAD_DIR, row.filename);
      fs.unlink(filePath, (unlinkErr) => {
        // ignore unlink errors
        res.redirect('/admin');
      });
    });
  });
});

// Start
app.listen(port, () => {
  console.log(`App listening on http://localhost:${port}`);
});
