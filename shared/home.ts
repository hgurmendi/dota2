import { getSession, signInUrl, signOut } from "./auth.ts";
import type { Session } from "./auth.ts";

const el = document.getElementById("auth")!;

function render(session: Session | null) {
  el.replaceChildren();

  if (!session) {
    const a = document.createElement("a");
    a.className = "btn";
    a.href = signInUrl("/");
    a.textContent = "Steam Sign In (optional)";
    el.append(a);
    return;
  }

  if (session.avatar) {
    const img = document.createElement("img");
    img.className = "avatar";
    img.src = session.avatar;
    img.alt = "";
    el.append(img);
  }

  const name = document.createElement("span");
  name.className = "persona";
  // Persona names come from Steam and are attacker-controlled; textContent
  // keeps them text rather than markup.
  name.textContent = session.persona || session.steamid;
  el.append(name);

  const out = document.createElement("button");
  out.className = "btn btn-quiet";
  out.textContent = "Sign out";
  out.addEventListener("click", async () => {
    out.disabled = true;
    await signOut();
    render(null);
  });
  el.append(out);
}

render(await getSession());
