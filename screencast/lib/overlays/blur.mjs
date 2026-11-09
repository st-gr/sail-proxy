// Injected into every recorded document: on GitHub pages, avatars (the signed-in account and the app owner) are
// blurred, so a sign-in through GitHub shows no face or picture. Idempotent by its style tag.
export const BLUR = `(() => {
  if (!location.hostname.endsWith('github.com') || document.querySelector('style[data-sail-blur]')) return;
  const style = document.createElement('style'); style.setAttribute('data-sail-blur', '');
  style.textContent = 'img.avatar, .avatar-user, .avatar img, img[src*="avatars.githubusercontent.com"], [style*="avatars.githubusercontent.com"] { filter: blur(14px) !important; }';
  document.head.appendChild(style);
})();`;
