// The Mechanical CAD setting for a browser script's test users.  CAD is a setting of each account, off by
// default (users.cad_enabled; web/shared/cad.ts), so a script that works with part studios or assemblies turns it
// on for each of its users, through the API a person's switch uses, before that user signs in:
//
//   import { setCad } from './cad-setting.mjs';
//   await setCad(BASE, jwt(uid, login));          // on
//   await setCad(BASE, jwt(uid, login), false);   // off again
//
// `token` is the user's session JWT (the one /auth/dev takes); it is sent as a bearer token.

/** Turn Mechanical CAD on (or off) for the user the token belongs to.  Returns the setting as the server stored it. */
export async function setCad(base, token, on = true) {
  const r = await fetch(`${base.replace(/\/$/, '')}/api/me/cad`, {
    method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ enabled: on }),
  });
  if (!r.ok) throw new Error(`PUT /api/me/cad answered ${r.status}: ${await r.text()}`);
  const me = await r.json();
  if (me.cad !== on) throw new Error(`PUT /api/me/cad left cad at ${me.cad}`);
  return me.cad;
}
