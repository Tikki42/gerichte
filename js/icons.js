// Schlichte Symbole im Stil der iOS-Systemsymbole (einfarbig, folgen der Textfarbe).

const svg = (body, size = 24) =>
  `<svg class="ico" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icon = {
  gear: (s) => svg('<circle cx="12" cy="12" r="8.2" stroke-width="3.2" stroke-dasharray="3.2 3.24" stroke-linecap="butt"/><circle cx="12" cy="12" r="6.2" stroke-width="2.2"/><circle cx="12" cy="12" r="2.3" stroke-width="2"/>', s),
  plus: (s) => svg('<path d="M12 5v14M5 12h14" stroke-width="2.4"/>', s),
  dice: (s) => svg('<rect x="3.5" y="3.5" width="17" height="17" rx="4.5" stroke-width="2"/><g fill="currentColor" stroke="none"><circle cx="8.3" cy="8.3" r="1.5"/><circle cx="15.7" cy="15.7" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="15.7" cy="8.3" r="1.5"/><circle cx="8.3" cy="15.7" r="1.5"/></g>', s),
  search: (s) => svg('<circle cx="10.8" cy="10.8" r="6.3" stroke-width="2.2"/><path d="M15.5 15.5l4.5 4.5" stroke-width="2.4"/>', s),
  back: (s) => svg('<path d="M15 5l-7 7 7 7" stroke-width="2.6"/>', s),
  close: (s) => svg('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11" stroke-width="2.4"/>', s),
  check: (s) => svg('<path d="M5 12.5l4.5 4.5L19 7.5" stroke-width="2.6"/>', s),
  again: (s) => svg('<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" stroke-width="2.3"/><path d="M19.5 4.5v4h-4" stroke-width="2.3"/>', s),
  bolt: (s) => svg('<path d="M13.5 2.5L5 13.5h6l-1.5 8 8.5-11h-6z" fill="currentColor" stroke="none"/>', s),
  clock: (s) => svg('<circle cx="12" cy="12" r="8.5" stroke-width="2"/><path d="M12 7.5V12l3 2" stroke-width="2"/>', s),
  camera: (s) => svg('<path d="M4 8.5A2 2 0 0 1 6 6.5h2l1.5-2h5l1.5 2h2a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" stroke-width="2"/><circle cx="12" cy="12.5" r="3.4" stroke-width="2"/>', s),
  sort: (s) => svg('<path d="M8 5v14M8 5L5 8M8 5l3 3M16 19V5M16 19l-3-3M16 19l3-3" stroke-width="2"/>', s),
  file: (s) => svg('<path d="M7 3.5h6.5L18 8v11.5a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z" stroke-width="2"/><path d="M13 3.5V8.5h5" stroke-width="2"/>', s),
};
