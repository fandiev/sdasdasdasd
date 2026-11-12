'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { hashPassword } = require('./auth');

const seedRooms = [
  ['atlas', 'Атлас', 'Конференц-зал', 'Просторный зал для презентаций, лекций и больших команд. Здесь удобно обмениваться идеями.', 80, 145, 3500, 'Проектор · Сцена · Аудиосистема · Wi-Fi', 'peach', '✳'],
  ['orbit', 'Орбита', 'Переговорная', 'Светлая переговорная с большим столом для продуктивных встреч и стратегических сессий.', 12, 35, 1600, 'Экран 4K · Видеосвязь · Флипчарт · Wi-Fi', 'lavender', '◉'],
  ['forma', 'Форма', 'Open space', 'Гибкое пространство для воркшопов, нетворкинга и творческих экспериментов.', 36, 90, 2400, 'Мобильная мебель · Колонки · Кофе · Wi-Fi', 'lime', '✦'],
  ['nord', 'Норд', 'Переговорная', 'Камерное пространство для важных переговоров в спокойной обстановке.', 6, 22, 950, 'Экран · Видеосвязь · Доска · Wi-Fi', 'blue', '⌁'],
  ['focus', 'Фокус', 'Переговорная', 'Минималистичный зал, где ничто не отвлекает от главного.', 8, 28, 1200, 'Проектор · Флипчарт · Вода · Wi-Fi', 'yellow', '◎'],
  ['horizon', 'Горизонт', 'Конференц-зал', 'Большое пространство с разными вариантами рассадки для ярких событий.', 120, 200, 4900, 'Сцена · 2 экрана · Микрофоны · Wi-Fi', 'coral', '✺'],
];

function openDatabase(filename = path.join(__dirname, '..', 'data', 'conference.sqlite')) {
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      phone TEXT DEFAULT '',
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      capacity INTEGER NOT NULL,
      area INTEGER NOT NULL,
      hourly_rate INTEGER NOT NULL,
      amenities TEXT NOT NULL,
      accent TEXT NOT NULL,
      symbol TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      room_id INTEGER NOT NULL REFERENCES rooms(id),
      date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      attendees INTEGER NOT NULL,
      payment_method TEXT NOT NULL,
      comment TEXT NOT NULL DEFAULT '',
      total INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','approved','rejected','completed')),
      admin_note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS bookings_room_date ON bookings(room_id, date, start_time, end_time);
    CREATE INDEX IF NOT EXISTS bookings_user ON bookings(user_id);
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id INTEGER NOT NULL UNIQUE REFERENCES bookings(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      comment TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      csrf TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);

  if (db.prepare('SELECT COUNT(*) AS n FROM rooms').get().n === 0) {
    const insert = db.prepare('INSERT INTO rooms (slug,name,category,description,capacity,area,hourly_rate,amenities,accent,symbol) VALUES (?,?,?,?,?,?,?,?,?,?)');
    for (const room of seedRooms) insert.run(...room);
  }

  // В учебном режиме создаются тестовые аккаунты. В production нужен свой секрет.
  const insertUser = db.prepare('INSERT OR IGNORE INTO users (username,full_name,email,phone,password_hash,role) VALUES (?,?,?,?,?,?)');
  if (process.env.NODE_ENV === 'production') {
    if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 12) {
      throw new Error('Для production задайте ADMIN_PASSWORD (минимум 12 символов). Не используйте учебную базу.');
    }
    insertUser.run('admin', 'Администратор пространства', 'admin@example.test', '', hashPassword(process.env.ADMIN_PASSWORD), 'admin');
    db.prepare('UPDATE users SET password_hash=? WHERE username=?').run(hashPassword(process.env.ADMIN_PASSWORD), 'admin');
  } else {
    insertUser.run('admin', 'Администратор пространства', 'admin@example.test', '', hashPassword(process.env.DEMO_ADMIN_PASSWORD || 'Admin2026!'), 'admin');
    insertUser.run('student', 'Александр Студентов', 'student@example.test', '+7 900 000-00-00', hashPassword('Student123!'), 'user');
  }

  if (db.prepare('SELECT COUNT(*) AS n FROM bookings').get().n === 0) {
    const student = db.prepare('SELECT id FROM users WHERE username = ?').get('student');
    if (student) {
    const room = db.prepare('SELECT id FROM rooms WHERE slug = ?').get('orbit');
    const day = new Date();
    day.setDate(day.getDate() - 10);
    const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    const example = db.prepare(`INSERT INTO bookings (user_id,room_id,date,start_time,end_time,attendees,payment_method,comment,total,status)
      VALUES (?,?,?,?,?,?,?,?,?,'completed')`).run(student.id, room.id, date, '11:00', '13:00', 6, 'На месте', 'Учебная презентация', 3200);
    db.prepare('INSERT INTO reviews (booking_id,user_id,rating,comment) VALUES (?,?,?,?)').run(Number(example.lastInsertRowid), student.id, 5, 'Уютно, удобно и всё оборудование работает отлично!');
    }
  }
  return db;
}

module.exports = { openDatabase };
