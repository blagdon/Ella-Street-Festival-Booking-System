import { fetchMapData } from './api.js';
import { escapeHtml } from './utils.js';
import { ESF_PUBLIC_CONFIG } from '../supabase-public.js';

// ===================================================================
// === TOAST NOTIFICATION SYSTEM (Map Specific) ===
// ===================================================================
function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    let iconSVG = '';
    // SVG icons will be shortened for brevity in this step
    if (type === 'error') iconSVG = '<svg class="toast-icon" fill="currentColor" style="color: #ef4444;" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd"/></svg>';
    else if (type === 'success') iconSVG = '<svg class="toast-icon" fill="currentColor" style="color: #10b981;" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg>';
    else iconSVG = '<svg class="toast-icon" fill="currentColor" style="color: #3b82f6;" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clip-rule="evenodd"/></svg>';

    toast.innerHTML = `
        ${iconSVG}
        <div class="toast-content">${message}</div>
        <svg class="toast-close" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
        </svg>
      `;

    const closeBtn = toast.querySelector('.toast-close');
    closeBtn.addEventListener('click', () => removeToast(toast));

    container.appendChild(toast);
    setTimeout(() => removeToast(toast), 5000);
}

function removeToast(toast) {
    toast.classList.add('hiding');
    setTimeout(() => toast.remove(), 300);
}

// ===================================================================
// === FESTIVAL ICONS MODULE ===
// ===================================================================
const FestivalIcons = (function () {

    const svgs = {
        food: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="white" /><path fill="none" stroke="#ef4444" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m4 12 2.66667-1 2.66666 1L12 11l2.6667 1 2.6666-1L20 12m-1 5H5v1c0 1.1046.89543 2 2 2h10c1.1046 0 2-.8954 2-2v-1ZM5 9.00003h14v-1c0-2.20914-1.7909-4-4-4H9c-2.20914 0-4 1.79086-4 4v1ZM18.5 14h-13c-.82843 0-1.5.6716-1.5 1.5 0 .8285.67157 1.5 1.5 1.5h13c.8284 0 1.5-.6715 1.5-1.5 0-.8284-.6716-1.5-1.5-1.5Z"/></svg>',
        music: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="10" fill="white" /><path d="M18 3a1 1 0 00-1.196-.98l-10 2A1 1 0 006 5v9.114A4.369 4.369 0 005 14c-1.657 0-3 .895-3 2s1.343 2 3 2 3-.895 3-2V7.82l8-1.6v5.894A4.37 4.37 0 0015 12c-1.657 0-3 .895-3 2s1.343 2 3 2 3-.895 3-2V3z"></path></svg>',
        stall: '<svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="32" fill="white" /><g><path fill="#3b82f6" d="M8,60c0,2.211,1.789,4,4,4h40c2.211,0,4-1.789,4-4v-2H8V60z"/><path fill="#3b82f6" d="M36,36c-0.553,0-1.053,0.224-1.414,0.586l-1.879,1.871c-0.391,0.391-1.023,0.391-1.414,0l-1.879-1.871 C29.053,36.224,28.553,36,28,36c-1.104,0-2,0.896-2,2c0,0.553,0.481,1.076,0.844,1.438L32,44.594l5.156-5.156 C37.519,39.076,38,38.553,38,38C38,36.896,37.104,36,36,36z"/><path fill="#3b82f6" d="M54,20H44v-8c0-6.627-5.373-12-12-12S20,5.373,20,12v8H10c-1.105,0-2,0.895-2,2v34h48V22 C56,20.895,55.105,20,54,20z M38.547,40.875l-5.84,5.841c-0.391,0.391-1.023,0.391-1.414,0l-5.855-5.856 C24.713,40.136,24,39.104,24,38c0-2.209,1.791-4,4-4c1.104,0,2.104,0.448,2.828,1.172L32,36.336l1.172-1.164 C33.896,34.448,34.896,34,36,34c2.209,0,4,1.791,4,4C40,39.104,39.271,40.151,38.547,40.875z M26,20v-8c0-3.313,2.687-6,6-6 s6,2.687,6,6v8H26z M42,23c0,0.553-0.447,1-1,1s-1-0.447-1-1V12c0-4.418-3.582-8-8-8s-8,3.582-8,8v11c0,0.553-0.447,1-1,1 s-1-0.447-1-1V12c0-5.522,4.478-10,10-10s10,4.478,10,10V23z"/></g></svg>',
        safety: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="10" fill="white" /><path fill-rule="evenodd" d="M3.172 5.172a4 4 0 015.656 0L10 6.343l1.172-1.171a4 4 0 115.656 5.656L10 17.657l-6.828-6.829a4 4 0 010-5.656z" clip-rule="evenodd"></path></svg>',
        beach: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="10" fill="white" /><path fill-rule="evenodd" d="M10 2c-4.418 0-8 3.582-8 8h16c0-4.418-3.582-8-8-8zM2.5 11h15a.5.5 0 0 1 0 1H10v5a.5.5 0 0 1-1 0v-5H2.5a.5.5 0 0 1 0-1z" clip-rule="evenodd"/></svg>',
        green: '<svg viewBox="0 0 120 120"><path d="M 112.61329,59.999923 A 52.613281,52.613197 0 0 1 60.000007,112.61312 52.613281,52.613197 0 0 1 7.3867254,59.999923 52.613281,52.613197 0 0 1 60.000007,7.3867255 52.613281,52.613197 0 0 1 112.61329,59.999923 Z" style="opacity:1;fill:#80deea;fill-opacity:1;stroke:none;"/><path d="m 58.207066,45.287805 -6.42696,27.651963 -0.897231,-7.473391 -1.643802,5.530177 -0.896749,-20.327768 c -1.622229,7.358237 -0.125938,15.340177 -9.117687,21.224515 L 33.507924,54.411733 c 0,0 -2.917665,14.738738 -4.238742,12.450576 -3.353957,-5.809226 -14.723698,-8.736903 -14.723698,-8.736903 0,0 6.679497,4.166239 4.084157,13.852184 -0.377859,1.410171 -5.495223,-9.482849 -5.495223,-9.482849 0,0 -2.478125,14.747291 -2.88088,14.436506 7.24298,21.310179 27.2391,35.652933 49.746541,35.682043 26.567887,-0.0229 48.949901,-19.849428 52.178011-46.220446 -3.84857,-3.15364 -3.43042,-7.526335 -4.79555-11.38953 l -2.24212,16.740292 -4.18494,-16.7405 0.59795,16.441567 c -2.930477,-1.53281 -3.241313,-3.814068 -3.437811,-6.128016 L 96.620548,73.08898 C 91.632747,66.45622 92.641677,58.966803 93.033554,51.565533 L 89.147145,72.341928 87.652557,67.70799 83.318026,76.825663 C 78.52624,67.108526 79.059004,58.456298 77.937028,49.473122 l -2.690245,24.512605 -4.484224,-4.035615 c 2.03842,5.785963 -1.917406,6.776567 -3.437806,9.715487 l 0.448627,-24.213663 -5.231785,20.47698 -2.541033,-6.426949 -1.643776,5.97883 C 55.686464,64.834146 57.522143,55.188841 58.207066,45.287805 Z" style="fill:#009688;fill-opacity:1;fill-rule:evenodd;"/><path d="m 61.793095,45.287805 6.426959,27.651963 0.89723,-7.473391 1.643802,5.530177 0.896749,-20.327768 c 1.622228,7.358237 0.125939,15.340177 9.117686,21.224515 l 5.71671-17.481568 c 0,0 2.91768,14.738738 4.238742,12.450576 3.353974,-5.809226 14.723707,-8.736903 14.723707,-8.736903 0,0 -6.679494,4.166239 -4.08417,13.852184 0.37786,1.410171 5.49523,-9.482849 5.49523,-9.482849 0,0 2.47812,14.747291 2.88088,14.436506 C 102.50365,98.241426 82.507521,112.58418 60.000079,112.61329 33.432193,112.59044 11.050186,92.763862 7.8220738,66.392844 11.67064,63.239204 11.252495,58.866509 12.617617,55.003314 l 2.242125,16.740292 4.184936,-16.7405 -0.597942,16.441567 c 2.930473,-1.53281 3.241309,-3.814068 3.437806,-6.128016 l 1.495072,7.772323 c 4.987801,-6.63276 3.97887,-14.122177 3.586993,-21.523447 l 3.88641,20.776395 1.494587,-4.633938 4.334529,9.117673 c 4.791787,-9.717137 4.259022,-18.369365 5.380998,-27.352541 l 2.690246,24.512605 4.484225,-4.035615 c -2.038421,5.785963 1.917404,6.776567 3.437806,9.715487 l -0.448629,-24.213663 5.231786,20.47698 2.541032,-6.426949 1.643776,5.97883 c 2.670322,-10.646651 0.834643,-20.291956 0.149722,-30.192992 z" style="fill:#00695c;fill-opacity:1;fill-rule:evenodd;"/></svg>',
        attraction: '<svg viewBox="0 0 508 508"><circle style="fill:#FFD05B;" cx="254" cy="254" r="254"/><path style="fill:#F9B54C;" d="M52.8,408.8C99.2,469.2,172,508,254,508s154.8-38.8,201.2-99.2H52.8z"/><g><rect x="347.383" y="228.379" transform="matrix(-0.2264 -0.974 0.974 -0.2264 259.049 666.4979)" style="fill:#324A5E;" width="93.627" height="4"/><rect x="268.428" y="246.424" transform="matrix(-0.2224 -0.975 0.975 -0.2224 143.095 610.9785)" style="fill:#324A5E;" width="93.544" height="4"/></g><polygon style="fill:#FFFFFF;" points="380.8,275.2 385.6,296.8 351.6,304.4 346.8,282.8 313.6,290.4 334,328.8 412,311.2 413.6,267.6 "/><g><rect x="111.804" y="183.586" transform="matrix(-0.974 -0.2265 0.2265 -0.974 172.465 480.5894)" style="fill:#324A5E;" width="4" height="93.629"/><rect x="190.796" y="201.629" transform="matrix(-0.975 -0.2222 0.2222 -0.975 325.576 533.4275)" style="fill:#324A5E;" width="3.999" height="93.54"/></g><polygon style="fill:#FFFFFF;" points="127.2,275.2 122.4,296.8 156.4,304.4 161.2,282.8 194.4,290.4 174,328.8 96,311.2 94.4,267.6 "/><g><polygon style="fill:#FF7058;" points="252.4,56 130,160.4 130,160.4 130,207.2 366.4,207.2 366.4,160.4"/><polygon style="fill:#FF7058;" points="406,391.2 102,391.2 112.4,363.2 395.6,363.2"/></g><g><path style="fill:#E6E9EE;" d="M409.6,391.2H98.4c-8.8,0-15.6,7.2-15.6,15.6v2h342.4v-2C425.2,398.4,418,391.2,409.6,391.2z"/><rect x="230.8" y="207.2" style="fill:#E6E9EE;" width="46.8" height="156"/></g><path style="fill:#F1543F;" d="M413.2,160.4c-13.2,0-23.6,10.4-23.6,23.6c0-13.2-10.4-23.6-23.6-23.6s-23.6,10.4-23.6,23.6c0-13.2-10.4-23.6-23.6-23.6s-23.6,10.4-23.6,23.6c0-13.2-10.4-23.6-23.6-23.6S248,170.8,248,184c0-13.2-10.4-23.6-23.6-23.6c-13.2,0-23.6,10.4-23.6,23.6c0-13.2-10.4-23.6-23.6-23.6c-13.2,0-23.6,10.4-23.6,23.6c0-13.2-10.4-23.6-23.6-23.6c-13.2,0-23.6,10.4-23.6,23.6v47.2h330v-47.2H413.2z"/><g><circle style="fill:#FFFFFF;" cx="130.4" cy="183.2" r="10.8"/><circle style="fill:#FFFFFF;" cx="177.6" cy="183.2" r="10.8"/><circle style="fill:#FFFFFF;" cx="224.8" cy="183.2" r="10.8"/><circle style="fill:#FFFFFF;" cx="271.6" cy="183.2" r="10.8"/><circle style="fill:#FFFFFF;" cx="318.8" cy="183.2" r="10.8"/><circle style="fill:#FFFFFF;" cx="366" cy="183.2" r="10.8"/><path style="fill:#FFFFFF;" d="M83.2,172.8V194c6,0,10.8-4.8,10.8-10.8C94,177.6,89.2,172.8,83.2,172.8z"/><path style="fill:#FFFFFF;" d="M413.2,172.8V194c-6,0-10.8-4.8-10.8-10.8C402.4,177.6,407.2,172.8,413.2,172.8z"/></g></svg>',
        barrier: '<svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="#ff5a79"></circle><path fill="#ffffff" d="M9 26h46v12H9z"></path></svg>',
        toilet: '<svg viewBox="0 0 50 50"><circle cx="25" cy="25" r="25" fill="white" /><path fill="#8b5cf6" d="M6 47.5c0 1.233.768 2 2 2c1.235 0 2-.767 2-2V29h2v18.5c0 1.231.767 2 2 2s2-.767 2-2V16h1v11.314c0 2.395 3.006 2.395 3 0V15.161C20 12.515 18.094 11 15 11H7c-2.82 0-5 1.219-5 4.087V28c0 2 3 2 3 0V16h1v31.5z"/><circle cx="10.875" cy="5.125" r="4.125" fill="#8b5cf6"/><circle cx="35.875" cy="5.125" r="4.125" fill="#8b5cf6"/><path fill="#8b5cf6" d="m45.913 32.5l-5.909-16.237l-.034-.167c0-.237.199-.429.447-.429c.211 0 .388.141.435.329L44.869 26.5c.267.601 1.365 1 2.087 1c.965 0 1.065-1.895 1.044-2l-4.017-10.107C43.634 13.072 41.29 11 38.615 11H33.38c-2.675 0-5.192 2.072-5.542 4.393l-3.837 10.232c-.087.199 0 1.938 1.044 1.938c.811 0 1.89-.314 2.086-1.031l3.875-10.564a.455.455 0 0 1 .422-.292c.246 0 .445.188.445.424l-.027.151l-5.758 16.251c-.012.048 0 1.2 0 1.249c0 .346.836 1.25 1.198 1.25H31v12.595c0 1.04.916 1.905 2 1.905s2-.866 2-1.905V34.491c0-.283 2-.274 2 .009v13c0 1.04.917 2 2 2c1.086 0 2-.961 2-2V35h3.869c.362 0 1.044-.904 1.044-1.25c0-.08.029-1.181 0-1.25z"/></svg>',
        police: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="white" /><g fill="none"><path fill="#092f63" d="M21.8 20.33L12 18.37l-9.8 1.96l-.98 2.94h21.56zM6.12 8.57v.98H4.16V12l1.96.98v1.96L12 17.39l5.88-2.45v-1.96l1.96-.98V9.55h-1.96v-.98l.49-1.96l2.94-1.47l-2.45-2.45L12 .73L5.14 2.69L2.69 5.14l2.94 1.47z"/><path fill="#bbd8ff" d="M18.37 6.61H12v3.43l5.88-1.47zm-4.998 14.602L12 18.37l-1.372 2.842L12 23.27zM18.468 4.65L12.98 2.984V4.16l-.98.98l-.98-.98V2.984L5.532 4.65L4.258 5.924l1.372.686h12.74l1.372-.686z"/><path stroke="#092f63" stroke-linecap="round" stroke-linejoin="round" stroke-miterlimit="10" d="M17.88 8.57v6.37L12 17.39l-5.88-2.45V8.57m11.76.98h1.96V12l-1.96.98M6.12 9.55H4.16V12l1.96.98m3.92-2.45v.98m3.92-.98v.98"/><path stroke="#092f63" stroke-linecap="round" stroke-linejoin="round" stroke-miterlimit="10" d="m10.53 14.45l1.47.49l1.47-.49m-6.86 4.998l-.98 1.862l1.96 1.96m9.8-3.822l.98 1.862l-1.96 1.96m-1.47-4.312L12 23.27l-2.94-4.312"/><path stroke="#092f63" stroke-linecap="round" stroke-linejoin="round" stroke-miterlimit="10" d="m22.78 23.27l-.98-2.94l-9.8-1.96l-9.8 1.96l-.98 2.94M18.37 6.61l-.49 1.96L12 10.04L6.12 8.57l-.49-1.96m7.35-2.45l-.98.98l-.98-.98V2.69h1.96z"/><path stroke="#092f63" stroke-linecap="round" stroke-linejoin="round" stroke-miterlimit="10" d="m18.37 6.61l2.94-1.47l-2.45-2.45L12 .73L5.14 2.69L2.69 5.14l2.94 1.47zm-4.998 14.602L12 18.37l-1.372 2.842L12 23.27z"/></g></svg>',
        fire: '<svg viewBox="0 0 128 128"><circle cx="64" cy="64" r="64" fill="white" /><path fill="#ed6c30" d="m50.57 49.04l.2.02c.28 0 .54-.11.74-.3c.24-.24.36-.59.31-.93l-.95-6.15a1.04 1.04 0 0 0-.62-.81a1.06 1.06 0 0 0-1.02.08l-7.03 4.68c-.36.24-.54.67-.45 1.1c.08.42.42.76.85.83l7.97 1.48zm-38.61.02l.19-.02l7.99-1.48c.42-.08.76-.41.85-.83c.09-.43-.1-.86-.46-1.1l-7.03-4.68c-.29-.2-.68-.23-1.02-.08c-.33.14-.57.45-.62.81l-.94 6.15a1.064 1.064 0 0 0 1.04 1.23z"/><path fill="#2f2f2f" d="M120.78 70.65H75.74V45.16l45.04 5.79z"/><path fill="#fff" d="m16.027 18.795l7.15-14.914l96.5 46.265l-7.15 14.914z"/><path fill="#2f2f2f" d="M113.53 67.9L13.18 19.8l8.99-18.76l100.35 48.1l-8.99 18.76zM18.87 17.79l92.66 44.41l5.3-11.06L24.17 6.73l-5.3 11.06z"/><path fill="#2f2f2f" d="M14.102 17.877L21.24 2.968l3.851 1.844l-7.14 14.909z"/><path fill="#fff" d="m112.53 65.05l7.14-14.91"/><path fill="#2f2f2f" d="m110.6 64.126l7.152-14.901l3.85 1.847l-7.153 14.902z"/><path fill="#fff" d="m96.44 57.34l7.15-14.91"/><path fill="#2f2f2f" d="m94.522 56.428l7.14-14.909l3.842 1.84l-7.14 14.908z"/><path fill="#fff" d="m80.36 49.64l7.15-14.92"/><path fill="#2f2f2f" d="m78.439 48.712l7.152-14.901l3.84 1.843l-7.152 14.902z"/><path fill="#fff" d="m64.27 41.92l7.15-14.9"/><path fill="#2f2f2f" d="M62.354 41.008L69.5 26.103l3.841 1.842l-7.146 14.905z"/><path fill="#fff" d="m48.19 34.21l7.15-14.9"/><path fill="#2f2f2f" d="m46.27 33.293l7.146-14.905l3.84 1.842l-7.145 14.905z"/><path fill="#fff" d="m32.11 26.51l7.14-14.92"/><path fill="#2f2f2f" d="m30.176 25.582l7.162-14.909l3.84 1.845l-7.162 14.909z"/><path fill="#fff" d="m39.25 11.59l-23.23 7.2"/><path fill="#2f2f2f" d="m15.392 16.757l23.23-7.2l1.265 4.08l-23.23 7.198z"/><path fill="#fff" d="m55.34 19.31l-23.23 7.2"/><path fill="#2f2f2f" d="m31.473 24.468l23.23-7.2l1.264 4.08l-23.23 7.198z"/><path fill="#fff" d="m71.42 27.02l-23.23 7.19"/><path fill="#2f2f2f" d="m47.563 32.177l23.23-7.199l1.265 4.079l-23.23 7.198z"/><path fill="#fff" d="m87.51 34.72l-23.23 7.2"/><path fill="#2f2f2f" d="m63.653 39.886l23.23-7.198l1.265 4.078l-23.23 7.199z"/><path fill="#fff" d="m103.59 42.43l-23.23 7.21"/><path fill="#2f2f2f" d="m79.72 47.586l23.245-7.183l1.26 4.08l-23.244 7.182z"/><path fill="#fff" d="m119.67 50.14l-23.22 7.2"/><path fill="#2f2f2f" d="m95.812 55.304l23.23-7.196l1.264 4.079l-23.23 7.196z"/><path fill="#ed6c30" d="M23.26 49.69c0-6.31 1.89-11.42 7.85-11.42s7.84 5.11 7.84 11.42H23.26z"/><path fill="#2f2f2f" d="M38.21 52.15H24c-1.47 0-2.68 1.2-2.68 2.67v5.09c0 1.48 1.21 2.68 2.68 2.68h14.21c1.48 0 2.68-1.2 2.68-2.68v-5.09c0-1.47-1.2-2.67-2.68-2.67z"/><path fill="#ed6c30" d="M61.22 65.98c-1.66 0-3.03-1.36-3.03-3.02v-2.33c0-1.67-1.36-3.03-3.03-3.03h-3.41c0-.01-1.36-.01-3.02-.01H16.7c-2.96 0-7.28 2.25-7.95 7.4c-.98 7.57-2.64 15.91-2.64 15.91c-.33 1.63-.6 4.32-.6 5.99c0 0-.04 21.34-.04 25.7c0 1.92 2.36 4.54 4.14 4.54h108.14c1.66 0 3.02-1.36 3.02-3.03V69c0-1.67-1.36-3.03-3.02-3.03H61.22z"/><path fill="#2f2f2f" d="M36.87 117.14c0 5.43-4.4 9.82-9.82 9.82c-5.43 0-9.83-4.39-9.83-9.82c0-5.43 4.4-9.82 9.83-9.82c5.42 0 9.82 4.39 9.82 9.82zm72.22 0c0 5.43-4.4 9.82-9.82 9.82c-5.43 0-9.83-4.39-9.83-9.82c0-5.43 4.4-9.82 9.83-9.82c5.42 0 9.82 4.39 9.82 9.82z"/><path fill="#fff" d="M95.91 69.61c-8.63 0-15.66 7.03-15.66 15.66c0 3.95 1.49 7.56 3.92 10.32H60.45v5.33h35.46c8.63 0 15.66-7.02 15.66-15.65s-7.03-15.66-15.66-15.66zm0 25.98c-5.69 0-10.32-4.62-10.32-10.32c0-5.69 4.63-10.32 10.32-10.32s10.33 4.63 10.33 10.32c-.01 5.69-4.64 10.32-10.33 10.32zM31.76 83.41a3.03 3.03 0 0 1-3.02 3.02H16.9c-1.66 0-2.83-1.34-2.59-2.99l2.09-14.42c.24-1.65 1.79-3 3.46-3h8.89c1.66 0 3.02 1.37 3.02 3.02v14.37zm20.26-14.87c0-1.43-1.17-2.61-2.61-2.61h-9.7a2.62 2.62 0 0 0-2.62 2.61v10.04c0 1.43 1.18 2.62 2.62 2.62h9.7a2.62 2.62 0 0 0 2.61-2.62V68.54z"/></svg>',
        ramp: '<svg viewBox="0 0 24 24"><path fill="none" stroke="#000000" d="M23 23.5v-7h-.5S15 21 1 23m3.28-11.366a4.424 4.424 0 1 0 5.145 2.382M4.28 11.634l.069-2.036a3 3 0 0 1 2.222-2.796l1.042-.28l1.027 3.833m-4.36 1.28a4.425 4.425 0 0 1 5.145 2.381m6.543 3.647c-1.73-.527-2.816-1.4-3.28-3.13l-.334-1.249l-2.733.732h-.196m-2.436-9.28s-1.701-.52-2.006-1.658A1.65 1.65 0 0 1 6.15 1.057a1.647 1.647 0 0 1 2.017 1.168c.305 1.138-.904 2.439-.904 2.439l-.274.073 Z"/></svg>',
        spokenword: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="white" /><path d="M5 4h14c1.66 0 3 1.34 3 3v6c0 1.66-1.34 3-3 3h-4l-3 3-3-3H5c-1.66 0-3-1.34-3-3V7c0-1.66 1.34-3 3-3z"/><path fill="white" d="M10 7.5c0-1.1.9-2 2-2s2 .9 2 2v3c0 1.1-.9 2-2 2s-2-.9-2-2v-3zm-1.5 2.5c0 1.9 1.3 3.5 3 3.9v1.6H10c-.3 0-.5.2-.5.5s.2.5.5.5h4c.3 0 .5-.2.5-.5s-.2-.5-.5-.5h-1.5v-1.6c1.7-.4 3-2 3-3.9c0-.3-.2-.5-.5-.5s-.5.2-.5.5c0 1.4-1.1 2.5-2.5 2.5s-2.5-1.1-2.5-2.5c0-.3-.2-.5-.5-.5s-.5.2-.5.5z"/></svg>',
        icecream: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="white" /><g transform="translate(0, 0.5)"><polygon points="8.5,14 10,21 14,21 15.5,14" fill="#d98c4b" /><clipPath id="cone-clip"><polygon points="8.5,14 10,21 14,21 15.5,14" /></clipPath><g clip-path="url(#cone-clip)"><line x1="8" y1="12" x2="16" y2="22" stroke="#b26e32" stroke-width="0.8" /><line x1="10" y1="12" x2="18" y2="22" stroke="#b26e32" stroke-width="0.8" /><line x1="6" y1="12" x2="14" y2="22" stroke="#b26e32" stroke-width="0.8" /><line x1="4" y1="12" x2="12" y2="22" stroke="#b26e32" stroke-width="0.8" /></g><rect x="7.5" y="13" width="9" height="1.5" rx="0.3" fill="#f0a967" /><line x1="9.3" y1="13" x2="9.3" y2="14.5" stroke="#d98c4b" stroke-width="0.35" /><line x1="11.1" y1="13" x2="11.1" y2="14.5" stroke="#d98c4b" stroke-width="0.35" /><line x1="12.9" y1="13" x2="12.9" y2="14.5" stroke="#d98c4b" stroke-width="0.35" /><line x1="14.7" y1="13" x2="14.7" y2="14.5" stroke="#d98c4b" stroke-width="0.35" /><path d="M12,1.5 C12,1.5 14,2.7 13.8,4 C13.6,4.8 14.8,4.9 15.4,5.4 C16.3,6.1 16.5,7.3 15.5,8 C16.8,8.7 17.2,9.8 16.2,10.7 C17.5,11.5 17.5,12.8 16.5,13 L7.5,13 C6.5,12.8 6.5,11.5 7.8,10.7 C6.8,9.8 7.2,8.7 8.5,8 C7.5,7.3 7.7,6.1 8.6,5.4 C9.2,4.9 10.4,4.8 10.2,4 C10,2.7 12,1.5 12,1.5 Z" fill="#fffbeb" /><path d="M12,1.5 C11.4,2.5 11.9,4 11.4,5 C10.9,6 11.4,7.5 10.9,8.5 C10.4,9.5 10.9,11 10.4,12 C10,12.5 10.5,13 12,13 L7.5,13 C6.5,12.8 6.5,11.5 7.8,10.7 C6.8,9.8 7.2,8.7 8.5,8 C7.5,7.3 7.7,6.1 8.6,5.4 C9.2,4.9 10.4,4.8 10.2,4 C10,2.7 12,1.5 12,1.5 Z" fill="#f5ebd6" /></g></svg>'
    };

    function injectColor(svgString, color) {
        if (!svgString) return "";
        return svgString.replace('<path', `<path style="fill: ${color}"`);
    }

    function getStyle(typeRaw) {
        const type = (typeRaw || "").toString().toLowerCase();

        if (type.includes('food') && !type.includes('non')) { return { color: '#ef4444', svg: svgs.food }; }
        if (type.includes('ice cream') || type.includes('van')) { return { color: '#f0a967', svg: svgs.icecream }; }
        if (type.includes('music')) { const color = '#ec4899'; return { color: color, svg: injectColor(svgs.music, color) }; }
        if (type.includes('beach')) { const color = '#f59e0b'; return { color: color, svg: injectColor(svgs.beach, color) }; }
        if (type.includes('green')) { return { color: '#009688', svg: svgs.green }; }
        if (type.includes('attraction') || type.includes('kids')) { return { color: '#f59e0b', svg: svgs.attraction }; }
        if (type.includes('toilet') || type.includes('wc')) { return { color: '#8b5cf6', svg: svgs.toilet }; }
        if (type.includes('police')) { return { color: '#092f63', svg: svgs.police }; }
        if (type.includes('fire')) { return { color: '#b91c1c', svg: svgs.fire }; }
        if (type.includes('aid') || type.includes('first aid')) { const color = '#16a34a'; return { color: color, svg: injectColor(svgs.safety, color) }; }
        if (type.includes('barrier')) { return { color: '#ff5a79', svg: svgs.barrier }; }
        if (type.includes('ramp')) { return { color: '#6b7280', svg: svgs.ramp }; }
        if (type.includes('spoken') || type.includes('word')) { const color = '#a855f7'; return { color: color, svg: injectColor(svgs.spokenword, color) }; }

        return { color: '#3b82f6', svg: svgs.stall };
    }

    return { getStyle: getStyle };
})();

// ===================================================================
// === MAP LOGIC ===
// ===================================================================

let map = null;
let markersLayer = null;
let userLayer = null;
let allEnrichedBookings = [];
let currentSearchTerm = '';
let searchMarkers = [];
let searchDebounceTimer = null;
let lastSearchNoResultsTerm = null;

export function initMap() {
    try {
        if (!L) throw new Error("Leaflet not loaded");
        map = L.map('map', { zoomControl: false }).setView(
            [ESF_PUBLIC_CONFIG.MAP_CENTER_LAT, ESF_PUBLIC_CONFIG.MAP_CENTER_LNG],
            ESF_PUBLIC_CONFIG.MAP_DEFAULT_ZOOM
        );
        L.control.zoom({ position: 'topright' }).addTo(map);

        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; OpenStreetMap',
            maxZoom: 19
        }).addTo(map);

        markersLayer = L.layerGroup().addTo(map);
        userLayer = L.layerGroup().addTo(map);

        map.getPane('markerPane').style.zIndex = 600;
        map.getPane('popupPane').style.zIndex = 700;

        const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
        setTimeout(function () {
            map.invalidateSize();
            loadMapData();
        }, isMobile ? 1000 : 500);

    } catch (err) {
        showToast("Error starting map: " + err.message, 'error');
    }
}

async function loadMapData() {
    try {
        const currentInstance = (typeof localStorage !== 'undefined' && localStorage.getItem('ESF_INSTANCE')) || 'LIVE';
        const mapItems = await fetchMapData(currentInstance);

        if (!mapItems || mapItems.length === 0) return;

        allEnrichedBookings = [];
        mapItems.forEach(item => {
            if (item.lat && item.lng) {
                allEnrichedBookings.push({
                    business_name: item.business,
                    description: item.description,
                    stall_type: item.stall_type,
                    category: item.category,
                    location_id: item.location_id,
                    lat: item.lat,
                    lng: item.lng,
                    type: (item.stall_type || 'stall').toLowerCase()
                });
            }
        });

        if (allEnrichedBookings.length === 0) return;
        applyFilter('all');

    } catch (err) {
        showToast("Error loading map data: " + err.message, 'error');
    }
}

export function applyFilter(filterType) {
    if (!markersLayer) return;
    markersLayer.clearLayers();
    searchMarkers = [];

    let matchCount = 0;
    let searchMatchCount = 0;

    allEnrichedBookings.forEach(item => {
        const type = item.type;
        let isMatch = false;

        if (filterType === 'all') isMatch = true;
        else if (filterType === 'food' && (type.includes('food') || type.includes('ice cream') || type.includes('van')) && !type.includes('non')) isMatch = true;
        else if (filterType === 'stall') {
            const isNonFoodOrStall = type.includes('non') || type.includes('stall');
            const isOtherCategory = type.includes('music') || type.includes('toilet') || type.includes('wc') ||
                type.includes('police') || type.includes('aid') || type.includes('fire') ||
                type.includes('attraction') || type.includes('kids') || type.includes('green') ||
                type.includes('beach') || type.includes('barrier') || type.includes('ramp') ||
                type.includes('spoken') || type.includes('word') ||
                (type.includes('food') && !type.includes('non'));
            isMatch = isNonFoodOrStall && !isOtherCategory;
        } else if (filterType === 'toilet' && (type.includes('toilet') || type.includes('wc'))) isMatch = true;
        else if (filterType === 'safety' && (type.includes('police') || type.includes('aid') || type.includes('fire'))) isMatch = true;
        else if (filterType === 'attraction' && (type.includes('attraction') || type.includes('kids'))) isMatch = true;
        else if (filterType === 'music' && type.includes('music')) isMatch = true;
        else if (filterType === 'green' && type.includes('green')) isMatch = true;
        else if (filterType === 'beach' && type.includes('beach')) isMatch = true;
        else if (filterType === 'spokenword' && (type.includes('spoken') || type.includes('word'))) isMatch = true;

        if (!isMatch) return;
        if (!matchesSearch(item)) return;

        matchCount++;
        searchMatchCount++;

        const style = FestivalIcons.getStyle(type);
        const icon = L.divIcon({
            className: 'custom-pin',
            html: `<div class="pin-outer" style="box-shadow: 0 0 8px ${style.color}50, 0 2px 5px rgba(0,0,0,0.15); border: 1.5px solid ${style.color}bb; transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);" onmouseover="this.style.boxShadow='0 0 16px ${style.color}, 0 2px 8px rgba(0,0,0,0.2)'; this.style.transform='scale(1.2)'; this.style.zIndex='1000';" onmouseout="this.style.boxShadow='0 0 8px ${style.color}50, 0 2px 5px rgba(0,0,0,0.15)'; this.style.transform='scale(1)'; this.style.zIndex='';">${style.svg}</div>`,
            iconSize: [32, 32],
            iconAnchor: [16, 16],
            popupAnchor: [0, -16]
        });

        const marker = L.marker([item.lat, item.lng], { icon: icon })
            .bindPopup(`
                <div class="p-3" style="min-width: 200px;">
                  <p class="text-xs text-gray-500 mb-2">Location ID: ${escapeHtml(item.location_id || 'N/A')}</p>
                  <h3 class="font-bold text-base text-gray-900 mb-1">${escapeHtml(item.business_name || 'Unknown')}</h3>
                  <p class="text-xs text-gray-600 mb-2">${escapeHtml(item.category || 'General')}</p>
                  ${item.description ? `<p class="text-xs text-gray-500 leading-relaxed">${escapeHtml(item.description)}</p>` : ''}
                </div>
              `, {
                maxWidth: 280,
                className: 'custom-popup'
            });

        marker.addTo(markersLayer);
        searchMarkers.push({ marker, item });
    });

    if (currentSearchTerm && matchCount === 0 && lastSearchNoResultsTerm !== currentSearchTerm) {
        lastSearchNoResultsTerm = currentSearchTerm;
        showToast(`No results found for "${currentSearchTerm}"`, 'info');
    } else if (currentSearchTerm && searchMatchCount === 1) {
        const result = searchMarkers[0];
        map.setView([result.item.lat, result.item.lng], 19);
        result.marker.openPopup();
    }
}

export function handleSearch(searchTerm) {
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);

    currentSearchTerm = searchTerm.trim().toLowerCase();
    const clearBtn = document.getElementById('clear-search');

    if (currentSearchTerm) {
        if (clearBtn) clearBtn.classList.remove('hidden');
    } else {
        if (clearBtn) clearBtn.classList.add('hidden');
        lastSearchNoResultsTerm = null;
    }

    searchDebounceTimer = setTimeout(() => {
        const filterSelect = document.getElementById('filter-select');
        const currentFilter = filterSelect ? filterSelect.value : 'all';
        applyFilter(currentFilter);
    }, 300);
}

export function clearSearch() {
    const searchInput = document.getElementById('search-input');
    const clearBtn = document.getElementById('clear-search');

    if (searchInput) searchInput.value = '';
    currentSearchTerm = '';

    if (clearBtn) clearBtn.classList.add('hidden');

    const filterSelect = document.getElementById('filter-select');
    const currentFilter = filterSelect ? filterSelect.value : 'all';
    applyFilter(currentFilter);
}

function matchesSearch(item) {
    if (!currentSearchTerm) return true;
    const searchableText = [
        item.business_name || '',
        item.category || '',
        item.location_id || '',
        item.description || ''
    ].join(' ').toLowerCase();
    return searchableText.includes(currentSearchTerm);
}

export function locateUser() {
    if (!navigator.geolocation) {
        showToast("Geolocation is not supported by your browser.", 'warning');
        return;
    }

    navigator.geolocation.getCurrentPosition(
        function (position) {
            const lat = position.coords.latitude;
            const lng = position.coords.longitude;

            userLayer.clearLayers();

            L.marker([lat, lng], {
                icon: L.divIcon({
                    className: 'custom-pin',
                    html: `<div class="pin-outer" style="background: #3b82f6; border: 2px solid white;">
                           <svg class="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 20 20">
                             <path fill-rule="evenodd" d="M5.05 4.05a7 7 0 119.9 9.9L10 18.9l-4.95-4.95a7 7 0 010-9.9zM10 11a2 2 0 100-4 2 2 0 000 4z" clip-rule="evenodd"/>
                           </svg>
                         </div>`,
                    iconSize: [32, 32],
                    iconAnchor: [16, 16]
                })
            }).addTo(userLayer);

            map.setView([lat, lng], 18);
            showToast("Location found!", 'success');
        },
        function (error) {
            showToast("Unable to retrieve your location: " + error.message, 'error');
        }
    );
}
