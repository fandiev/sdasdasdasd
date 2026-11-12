'use strict';
document.addEventListener('DOMContentLoaded', () => {
  const button = document.querySelector('.menu-toggle');
  const nav = document.querySelector('.main-nav');
  if (button && nav) {
    button.addEventListener('click', () => {
      const open = nav.classList.toggle('open');
      button.setAttribute('aria-expanded', String(open));
      button.setAttribute('aria-label', open ? 'Закрыть меню' : 'Открыть меню');
      button.textContent = open ? '✕' : '☰';
    });
    nav.addEventListener('click', e => {
      if (e.target.closest('a')) {
        nav.classList.remove('open'); button.setAttribute('aria-expanded','false');button.textContent = '☰';
      }
    });
  }
  const booking = document.querySelector('.booking-form');
  if (booking) {
    const start = booking.querySelector('[name="start_time"]');
    const end = booking.querySelector('[name="end_time"]');
    if (start && end) {
      const update = () => {
        const sv = Number(start.value.split(':')[0]);
        for (const option of end.options) option.disabled = Number(option.value.split(':')[0]) <= sv;
        if (Number(end.value.split(':')[0]) <= sv) end.value = end.options[Array.from(end.options).findIndex(x => !x.disabled)].value;
      };
      start.addEventListener('change',update); update();
    }
  }
});
