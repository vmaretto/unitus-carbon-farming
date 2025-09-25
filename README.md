# Master in Carbon Farming – UNITUS

Landing page ufficiale del **Master Universitario di II livello in Carbon Farming**  
Università degli Studi della Tuscia – Unitus Academy

👉 **Demo online**: [https://<tuo-username>.github.io/<repo-name>/](https://<tuo-username>.github.io/<repo-name>/)  
(sostituisci `<tuo-username>` e `<repo-name>` con i valori della tua repo GitHub)

---

## 📂 Struttura del progetto
- `index.html` → pagina principale
- `assets/img/` → immagini (es. logo `logo-tuscia.png`)
- `.gitignore` → file per escludere cartelle/file inutili
- `.github/workflows/pages.yml` → workflow GitHub Pages per il deploy automatico

---

## 🚀 Visualizzare in locale
### Opzione 1 – Apri direttamente
Apri `index.html` con un browser (doppio click sul file).

### Opzione 2 – Con un piccolo server locale
Se vuoi simulare meglio l’ambiente web:

```bash
# con Node.js (installato)
npm i -g http-server
http-server -p 5173

# oppure con Python
python3 -m http.server 5173
