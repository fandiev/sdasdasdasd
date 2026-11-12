'use strict';

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const { openDatabase } = require('./db');
const { hashPassword, verifyPassword, token } = require('./auth');
const V = require('./views');

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const ROOM_JOIN = `SELECT b.*, r.name, r.slug, r.accent, r.symbol, r.category, u.full_name, u.email, u.phone
  FROM bookings b JOIN rooms r ON r.id=b.room_id JOIN users u ON u.id=b.user_id`;

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function safeString(x, limit=500) { return typeof x === 'string' ? x.trim().slice(0, limit) : ''; }
function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const parsed = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0,10) === s;
}
function validTime(s) { return /^(09|1\d|20|21|22):00$/.test(s); }
function overlapping(db, {id=null,room_id,date,start_time,end_time}) {
  return Boolean(db.prepare(`SELECT id FROM bookings WHERE room_id=? AND date=? AND status IN ('approved','completed')
   AND start_time < ? AND end_time > ? AND (? IS NULL OR id != ?) LIMIT 1`)
    .get(room_id, date, end_time, start_time, id, id));
}
function parseCookies(req) {
  const cookies = Object.create(null);
  for (const item of (req.headers.cookie || '').split(';')) {
    const at = item.indexOf('=');
    if (at > 0) cookies[item.slice(0,at).trim()] = item.slice(at+1).trim();
  }
  return cookies;
}
function urlEncoded(req) {
  return new Promise((resolve, reject) => {
    const type = (req.headers['content-type'] || '').split(';')[0];
    if (type !== 'application/x-www-form-urlencoded') return reject(Object.assign(new Error('Требуется форма'), {status:415}));
    let data='';
    req.setEncoding('utf8');
    req.on('data', chunk => { data += chunk; if(data.length > 16000) req.destroy(); });
    req.on('end', () => {
      if (data.length > 16000) return reject(Object.assign(new Error('Слишком большая форма'), {status:413}));
      const values=Object.create(null);
      for (const [key,value] of new URLSearchParams(data)) if(!Object.hasOwn(values,key)) values[key]=value;
      resolve(values);
    });
    req.on('error',reject);
  });
}

function createApp({db=openDatabase(), secureCookies=process.env.NODE_ENV==='production'}={}) {
  const cookieOptions = `Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secureCookies?'; Secure':''}`;
  const selectRoom = db.prepare('SELECT * FROM rooms WHERE id=?');
  const selectBooking = db.prepare(`${ROOM_JOIN} WHERE b.id=?`);
  const selectUser = db.prepare('SELECT id,username,full_name,email,phone,role FROM users WHERE id=?');
  const getSession = db.prepare('SELECT user_id,csrf,expires_at FROM sessions WHERE id=?');
  const insertSession = db.prepare('INSERT INTO sessions(id,user_id,csrf,expires_at) VALUES (?,?,?,?)');
  const getRooms = db.prepare('SELECT * FROM rooms ORDER BY id');
  const getReviews = db.prepare('SELECT rv.*, u.full_name FROM reviews rv JOIN users u ON u.id=rv.user_id JOIN bookings b ON b.id=rv.booking_id WHERE b.room_id=? ORDER BY rv.id DESC LIMIT 12');
  const activeConflict = db.prepare(`SELECT id FROM bookings WHERE room_id=? AND date=? AND status IN ('approved','completed')
    AND start_time < ? AND end_time > ? LIMIT 1`);
  let count=0;

  return async function handler(req, res) {
    try {
      const u = new URL(req.url || '/', 'http://localhost');
      const route = u.pathname;
      const method = req.method || 'GET';
      const write = (code, body, headers={}) => { res.writeHead(code, {'content-type':'text/html; charset=utf-8','x-content-type-options':'nosniff','referrer-policy':'strict-origin-when-cross-origin','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",...headers}); res.end(body); };
      const redirect = (to) => { res.writeHead(303, {'location':to,'cache-control':'no-store'}); res.end(); };
      if (method === 'GET' && ['/styles.css','/app.js','/favicon.svg'].includes(route)) {
        const mime = {'/styles.css':'text/css; charset=utf-8','/app.js':'text/javascript; charset=utf-8','/favicon.svg':'image/svg+xml'};
        const file = path.join(PUBLIC_DIR,route);
        fs.readFile(file,(err,body)=>{ if(err) return write(404,'Not Found'); res.writeHead(200,{'content-type':mime[route],'cache-control':'public, max-age=3600','x-content-type-options':'nosniff'});res.end(body); });
        return;
      }
      if (!['GET','POST'].includes(method)) return write(405,'Method not allowed',{'allow':'GET, POST'});
      if (++count % 100 === 0) db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
      let sid = parseCookies(req).session;
      const digest = x => crypto.createHash('sha256').update(x).digest('hex');
      let s = sid && /^[0-9a-f]{64}$/.test(sid) ? getSession.get(digest(sid)) : null;
      if (!s || s.expires_at <= Date.now()) {
        sid=token(32); s={user_id:null,csrf:token(24),expires_at:Date.now()+604800000};
        insertSession.run(digest(sid),null,s.csrf,s.expires_at);
        res.setHeader('Set-Cookie',`session=${sid}; ${cookieOptions}`);
      }
      const user = s.user_id ? selectUser.get(s.user_id) || null : null;
      const csrf = s.csrf;
      const page=(title,content,opts={}) => write(opts.code||200,V.layout(title,content,{user,csrf,path:route,notice:u.searchParams.get('notice')||'',...opts}),{'cache-control':'no-store'});
      const notFound = () => page('Ошибка 404',V.errorPage({}),{code:404});
      const forbidden=()=>page('Доступ закрыт',V.errorPage({code:403,title:'Нет доступа',message:'Для этой страницы нужны дополнительные права.'}),{code:403});
      const requireUser = () => {if(!user){redirect('/login?next='+encodeURIComponent(route));return false;}return true;};
      const requireAdmin=()=> {if(!requireUser())return false;if(user.role!=='admin'){forbidden();return false;}return true;};
      const params = method==='POST' ? await urlEncoded(req) : null;
      if(method==='POST' && (typeof params.csrf!=='string' || params.csrf!==csrf)) return write(403,'Недействительный CSRF-токен. Обновите страницу и попробуйте снова.');

      if(route==='/' && method==='GET') return page('Главная',V.home({rooms:getRooms.all()}));
      if(route==='/rooms' && method==='GET'){
        const category=u.searchParams.get('category')||'all';
        return page('Каталог залов',V.roomsPage({rooms:category==='all'?getRooms.all():db.prepare('SELECT * FROM rooms WHERE category=? ORDER BY id').all(category),filter:category}));
      }
      let m=route.match(/^\/rooms\/([a-z0-9-]+)$/);
      if(m && method==='GET'){
        const room=db.prepare('SELECT * FROM rooms WHERE slug=?').get(m[1]);
        if(!room)return notFound();
        return page(room.name,V.roomPage({room,reviews:getReviews.all(room.id)}));
      }
      if((route==='/login'||route==='/register') && method==='GET'){
        if(user)return redirect('/dashboard');
        return page(route==='/login'?'Вход':'Регистрация',V.authPage({mode:route.slice(1),csrf,showDemo:process.env.NODE_ENV!=='production'}));
      }
      if(route==='/register' && method==='POST'){
        if(user)return redirect('/dashboard');
        const values={full_name:safeString(params.full_name,80),username:safeString(params.username,32),email:safeString(params.email,120).toLowerCase(),phone:safeString(params.phone,25)};
        const pass=String(params.password||'');
        const fail=message=>page('Регистрация',V.authPage({mode:'register',csrf,error:message,values,showDemo:process.env.NODE_ENV!=='production'}),{code:400});
        if(values.full_name.length<2 || !/^[a-zA-Zа-яА-ЯёЁ0-9_\-]{3,32}$/.test(values.username) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) return fail('Заполните имя, логин (3–32 символа) и корректную почту.');
        if(pass.length<8 || pass.length>128) return fail('Пароль должен содержать от 8 до 128 символов.');
        if(values.phone.length>25)return fail('Неверный номер телефона.');
        if(db.prepare('SELECT id FROM users WHERE username=? OR email=?').get(values.username,values.email))return fail('Логин или электронная почта уже заняты.');
        const inserted=db.prepare('INSERT INTO users(username,full_name,email,phone,password_hash) VALUES(?,?,?,?,?)')
          .run(values.username,values.full_name,values.email,values.phone,hashPassword(pass));
        db.prepare('DELETE FROM sessions WHERE id=?').run(digest(sid));
        sid=token(32); insertSession.run(digest(sid),Number(inserted.lastInsertRowid),token(24),Date.now()+604800000);
        res.setHeader('Set-Cookie',`session=${sid}; ${cookieOptions}`);
        return redirect('/dashboard?notice=welcome');
      }
      if(route==='/login' && method==='POST'){
        if(user)return redirect('/dashboard');
        const name=safeString(params.username,120),password=String(params.password||'');
        const matched=db.prepare('SELECT * FROM users WHERE username=?').get(name);
        if(!matched||!verifyPassword(password,matched.password_hash))return page('Вход',V.authPage({mode:'login',csrf,error:'Неверный логин или пароль.',values:{username:name},showDemo:process.env.NODE_ENV!=='production'}),{code:401});
        // Rotate the session after authentication to prevent fixation.
        db.prepare('DELETE FROM sessions WHERE id=?').run(digest(sid));
        sid=token(32);insertSession.run(digest(sid),matched.id,token(24),Date.now()+604800000);
        res.setHeader('Set-Cookie',`session=${sid}; ${cookieOptions}`);
        return redirect('/dashboard?notice=login');
      }
      if(route==='/logout' && method==='POST'){
        db.prepare('DELETE FROM sessions WHERE id=?').run(digest(sid));
        res.setHeader('Set-Cookie',`session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
        return redirect('/?notice=logout');
      }
      m=route.match(/^\/book\/(\d+)$/);
      if(m){
        if(!requireUser())return;
        const room=selectRoom.get(Number(m[1])); if(!room)return notFound();
        const renderBook=(error='',values={})=>page('Бронирование',V.bookingFormPage({room,csrf,error,values,minDate:todayISO()}),{code:error?400:200});
        if(method==='GET')return renderBook();
        if(method==='POST'){
          const values={date:safeString(params.date,12),start_time:safeString(params.start_time,5),end_time:safeString(params.end_time,5),attendees:safeString(params.attendees,5),payment_method:safeString(params.payment_method,40),comment:safeString(params.comment,500)};
          const attendees=Number(values.attendees);
          if(!validDate(values.date)||values.date<todayISO()||!validTime(values.start_time)||!validTime(values.end_time)||values.start_time>=values.end_time||!Number.isInteger(attendees)||attendees<1||attendees>room.capacity||!['На месте','По счёту'].includes(values.payment_method))return renderBook('Проверьте дату, время, количество гостей и способ оплаты.',values);
          if(activeConflict.get(room.id,values.date,values.end_time,values.start_time))return renderBook('Этот зал уже забронирован на выбранное время. Пожалуйста, выберите другой интервал.',values);
          const duration=Number(values.end_time.slice(0,2))-Number(values.start_time.slice(0,2));
          const total=room.hourly_rate*duration;
          const result=db.prepare(`INSERT INTO bookings(user_id,room_id,date,start_time,end_time,attendees,payment_method,comment,total)
            VALUES(?,?,?,?,?,?,?,?,?)`).run(user.id,room.id,values.date,values.start_time,values.end_time,attendees,values.payment_method,values.comment,total);
          return redirect(`/booking/${result.lastInsertRowid}?notice=booked`);
        }
      }
      if(route==='/dashboard' && method==='GET'){
        if(!requireUser())return;
        const bookings=db.prepare(`${ROOM_JOIN} WHERE b.user_id=? ORDER BY b.id DESC`).all(user.id);
        return page('Личный кабинет',V.dashboard({user,bookings}));
      }
      m=route.match(/^\/booking\/(\d+)$/);
      if(m && method==='GET'){
        if(!requireUser())return;
        const booking=selectBooking.get(Number(m[1]));if(!booking)return notFound();
        if(booking.user_id!==user.id && user.role!=='admin')return forbidden();
        const review=db.prepare('SELECT * FROM reviews WHERE booking_id=?').get(booking.id);
        return page('Бронирование',V.bookingDetail({booking,csrf,review}));
      }
      m=route.match(/^\/reviews\/(\d+)$/);
      if(m && method==='POST'){
        if(!requireUser())return;
        const booking=selectBooking.get(Number(m[1]));if(!booking)return notFound();
        if(booking.user_id!==user.id||booking.status!=='completed')return forbidden();
        const rating=Number(params.rating),comment=safeString(params.comment,500);
        if(!Number.isInteger(rating)||rating<1||rating>5||comment.length<5)return write(400,'Оценка должна быть от 1 до 5, отзыв не короче 5 символов.');
        if(db.prepare('SELECT id FROM reviews WHERE booking_id=?').get(booking.id))return redirect(`/booking/${booking.id}`);
        db.prepare('INSERT INTO reviews(booking_id,user_id,rating,comment) VALUES(?,?,?,?)').run(booking.id,user.id,rating,comment);
        return redirect(`/booking/${booking.id}?notice=reviewed`);
      }
      if(route==='/admin' && method==='GET'){
        if(!requireAdmin())return;
        const bookings=db.prepare(`${ROOM_JOIN} ORDER BY b.id DESC`).all();
        const stats={all:bookings.length,new:bookings.filter(b=>b.status==='new').length,approved:bookings.filter(b=>b.status==='approved').length,completed:bookings.filter(b=>b.status==='completed').length};
        return page('Администрирование',V.admin({bookings,stats}));
      }
      m=route.match(/^\/admin\/booking\/(\d+)$/);
      if(m){
        if(!requireAdmin())return;
        const booking=selectBooking.get(Number(m[1]));if(!booking)return notFound();
        if(method==='GET')return page('Заявка №'+booking.id,V.adminBooking({booking,csrf}));
        if(method==='POST'){
          const status=safeString(params.status,20),note=safeString(params.admin_note,500);
          if(!['new','approved','rejected','completed'].includes(status))return page('Заявка',V.adminBooking({booking,csrf,error:'Выберите существующий статус.'}),{code:400});
          if((status==='approved'||status==='completed')&&overlapping(db,{...booking,id:booking.id}))return page('Заявка',V.adminBooking({booking,csrf,error:'На это время уже есть подтверждённое бронирование этого зала.'}),{code:409});
          db.prepare('UPDATE bookings SET status=?,admin_note=? WHERE id=?').run(status,note,booking.id);
          return redirect(`/admin/booking/${booking.id}?notice=updated`);
        }
      }
      return notFound();
    } catch(err){
      console.error('[server]',err);
      if(!res.headersSent){res.writeHead(err.status||500,{'content-type':'text/plain; charset=utf-8'});res.end(err.status?err.message:'Внутренняя ошибка сервера');}
    }
  };
}

if (require.main===module){
  const port=Number(process.env.PORT)||3000;
  const host=process.env.HOST||'127.0.0.1';
  http.createServer(createApp()).listen(port,host,()=>console.log(`ПЛОЩАДКА. доступна на http://${host}:${port}`));
}
module.exports={createApp,validDate,validTime,overlapping,todayISO};
