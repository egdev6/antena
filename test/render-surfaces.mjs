// Pages and key components of the render baseline (#360). The scenario opens one page per entry;
// `components` are the labels passed to countRender() in app/src. To measure another component,
// call countRender('<surface>/<Component>') in its source and list the label here.
export const SURFACES = [
  { page: 'panel/directo', url: '/#/directo', components: ['panel/Sidebar', 'panel/Directo'],
    ready: `!!document.querySelector('[data-tour-view-ready="directo"]')` },
  // `shows`: element that must contain the last chat message once the burst has arrived
  { page: 'panel/chat', url: '/#/chat', components: ['panel/Sidebar', 'panel/Chat'],
    ready: `!!document.querySelector('.chatlog')`, shows: '.chatlog' },
  { page: 'dock', url: '/dock', components: ['dock/Status'],
    ready: `!!document.querySelector('.dock .d-top')` },
  { page: 'prompter', url: '/prompter', components: ['prompter/Top', 'prompter/Eventos', 'prompter/Chat'],
    ready: `!!(document.querySelector('.top .clock') && document.querySelector('.chat'))`, shows: '.msgs' },
];

/** Every distinct component label the baseline reports. */
export const RENDER_COMPONENTS = [...new Set(SURFACES.flatMap(surface => surface.components))];
