'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDatabase } = require('../src/db');
const { createApp,validDate,overlapping } = require('../src/server');

let server, url, db;
const csrfOf = html => html.match(/name="csrf" value="([^"]+)"/)?.[1];
function cookieOf(response) { return response.headers.get('set-cookie')?.split(';')[0] || ''; }
async function request(route, {cookie='',form=null}={}) {
  const res=await fetch(url+route,{method:form?'POST':'GET',headers:cookie?{cookie}:undefined,body:form?new URLSearchParams(form):undefined,redirect:'manual'});
  return {res,body:await res.text(),cookie:cookieOf(res)};
}
async function login(username,password){
  const page=await request('/login');
  const answer=await request('/login',{cookie:page.cookie,form:{username,password,csrf:csrfOf(page.body)}});
  assert.equal(answer.res.status,303,`Login failed: ${answer.body}`);
  return answer.cookie;
}

before(async()=>{
  db=openDatabase(':memory:');
  server=http.createServer(createApp({db,secureCookies:false}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  url=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{await new Promise(resolve=>server.close(resolve)); db.close()});

test('Главная и каталог доступны гостю, стили и скрипт загружаются',async()=>{
  const first=await request('/');assert.equal(first.res.status,200);assert.match(first.body,/Место для/);
  const catalogue=await request('/rooms');assert.equal(catalogue.res.status,200);assert.match(catalogue.body,/Орбита/);
  const room=await request('/rooms/orbit');assert.equal(room.res.status,200);assert.match(room.body,/1[\s\u00a0]600 ₽/);
  assert.equal((await request('/styles.css')).res.status,200);
  assert.equal((await request('/app.js')).res.status,200);
  assert.equal((await request('/rooms/missing')).res.status,404);
});

test('Регистрация, личный кабинет и выход',async()=>{
  const page=await request('/register');
  const signup=await request('/register',{cookie:page.cookie,form:{csrf:csrfOf(page.body),full_name:'Тестовый Пользователь',username:'testuser',email:'testuser@example.test',phone:'',password:'GoodPass2026!'}});
  assert.equal(signup.res.status,303);
  const cabinet=await request('/dashboard',{cookie:signup.cookie});
  assert.equal(cabinet.res.status,200);assert.match(cabinet.body,/Привет, Тестовый/);
  const csrf=csrfOf(cabinet.body);
  assert.equal((await request('/logout',{cookie:signup.cookie,form:{csrf}})).res.status,303);
  assert.equal((await request('/dashboard',{cookie:signup.cookie})).res.status,303);
});

test('Защита от CSRF и неавторизованного доступа',async()=>{
  const visitor=await request('/book/1');assert.equal(visitor.res.status,303);
  const page=await request('/login');
  const invalid=await request('/login',{cookie:page.cookie,form:{username:'student',password:'Student123!',csrf:'wrong'}});
  assert.equal(invalid.res.status,403);
  const bad=await request('/login',{cookie:page.cookie,form:{username:'student',password:'nope',csrf:csrfOf(page.body)}});
  assert.equal(bad.res.status,401);
  const userCookie=await login('student','Student123!');
  assert.equal((await request('/admin',{cookie:userCookie})).res.status,403);
});

test('Пользователь создаёт заявку; сумма рассчитывается сервером',async()=>{
  const userCookie=await login('student','Student123!');
  const page=await request('/book/2',{cookie:userCookie});
  const date=new Date();date.setDate(date.getDate()+4);
  const tomorrow=`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  globalThis.bookingDate=tomorrow;
  const form={csrf:csrfOf(page.body),date:tomorrow,start_time:'10:00',end_time:'12:00',attendees:'5',payment_method:'На месте',comment:'Важная встреча'};
  const booked=await request('/book/2',{cookie:userCookie,form});
  assert.equal(booked.res.status,303); assert.match(booked.res.headers.get('location'),/^\/booking\/\d+\?notice=booked$/);
  const detail=await request(booked.res.headers.get('location'),{cookie:userCookie});
  assert.match(detail.body,/3[\s\u00a0]200 ₽/); assert.match(detail.body,/Важная встреча/);
  globalThis.newBookingId=Number(booked.res.headers.get('location').match(/booking\/(\d+)/)[1]);
  const another=await request('/book/2',{cookie:userCookie});
  const bad=await request('/book/2',{cookie:userCookie,form:{...form,csrf:csrfOf(another.body),attendees:'500'}});
  assert.equal(bad.res.status,400);
  const past=await request('/book/2',{cookie:userCookie,form:{...form,csrf:csrfOf(another.body),date:'2020-01-01'}});
  assert.equal(past.res.status,400);
});

test('Администратор подтверждает бронь и блокирует пересекающуюся',async()=>{
  const adminCookie=await login('admin','Admin2026!');
  const page=await request(`/admin/booking/${globalThis.newBookingId}`,{cookie:adminCookie});
  assert.equal(page.res.status,200);
  const approve=await request(`/admin/booking/${globalThis.newBookingId}`,{cookie:adminCookie,form:{csrf:csrfOf(page.body),status:'approved',admin_note:'Принято!'}});
  assert.equal(approve.res.status,303);
  const blockedUser=await login('testuser','GoodPass2026!');
  const bookingPage=await request('/book/2',{cookie:blockedUser});
  const overlapping=await request('/book/2',{cookie:blockedUser,form:{csrf:csrfOf(bookingPage.body),date:globalThis.bookingDate,start_time:'11:00',end_time:'13:00',attendees:'5',payment_method:'На месте',comment:''}});
  assert.equal(overlapping.res.status,400);assert.match(overlapping.body,/уже забронирован/);
  const otherDate=new Date(`${globalThis.bookingDate}T12:00:00`);otherDate.setDate(otherDate.getDate()+1);
  const next=`${otherDate.getFullYear()}-${String(otherDate.getMonth()+1).padStart(2,'0')}-${String(otherDate.getDate()).padStart(2,'0')}`;
  const okay=await request('/book/2',{cookie:blockedUser,form:{csrf:csrfOf(bookingPage.body),date:next,start_time:'11:00',end_time:'13:00',attendees:'5',payment_method:'На месте'}});
  assert.equal(okay.res.status,303);
  const secondId=Number(okay.res.headers.get('location').match(/booking\/(\d+)/)[1]);
  // The same interval can be requested before an approval, but not approved twice.
  const again=await request('/book/2',{cookie:blockedUser,form:{csrf:csrfOf(bookingPage.body),date:next,start_time:'12:00',end_time:'14:00',attendees:'5',payment_method:'На месте'}});
  assert.equal(again.res.status,303);
  const thirdId=Number(again.res.headers.get('location').match(/booking\/(\d+)/)[1]);
  const secondPage=await request(`/admin/booking/${secondId}`,{cookie:adminCookie});
  assert.equal((await request(`/admin/booking/${secondId}`,{cookie:adminCookie,form:{csrf:csrfOf(secondPage.body),status:'approved'}})).res.status,303);
  const thirdPage=await request(`/admin/booking/${thirdId}`,{cookie:adminCookie});
  const rejected=await request(`/admin/booking/${thirdId}`,{cookie:adminCookie,form:{csrf:csrfOf(thirdPage.body),status:'approved'}});
  assert.equal(rejected.res.status,409);assert.match(rejected.body,/уже есть подтверждённое/);
});

test('Отзыв разрешён только после завершения, вторая отправка не создаёт дубль',async()=>{
  const adminCookie=await login('admin','Admin2026!');
  const adminPage=await request(`/admin/booking/${globalThis.newBookingId}`,{cookie:adminCookie});
  assert.equal((await request(`/admin/booking/${globalThis.newBookingId}`,{cookie:adminCookie,form:{csrf:csrfOf(adminPage.body),status:'completed'}})).res.status,303);
  const student=await login('student','Student123!');
  const detail=await request(`/booking/${globalThis.newBookingId}`,{cookie:student});
  const review=await request(`/reviews/${globalThis.newBookingId}`,{cookie:student,form:{csrf:csrfOf(detail.body),rating:'5',comment:'Всё было просто замечательно'}});
  assert.equal(review.res.status,303);
  const second=await request(`/reviews/${globalThis.newBookingId}`,{cookie:student,form:{csrf:csrfOf(detail.body),rating:'4',comment:'Повторный отзыв'}});
  assert.equal(second.res.status,303);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reviews WHERE booking_id=?').get(globalThis.newBookingId).n,1);
});

test('Пароли и данные экранируются, даты валидируются',async()=>{
  assert.equal(validDate('2026-02-30'),false);assert.equal(validDate('2026-12-31'),true);
  const userCookie=await login('student','Student123!');
  const detail=await request('/booking/99999',{cookie:userCookie});assert.equal(detail.res.status,404);
  assert.equal(overlapping(db,{room_id:2,date:globalThis.bookingDate,start_time:'11:00',end_time:'13:00'}),true);
});
