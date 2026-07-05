# INSTALL.md — instruções para o agente instalador (Claude Code)

Você é o Claude Code do usuário e vai instalar o **wa-concierge** na máquina dele, do início ao fim. Siga os passos na ordem. Fale com o usuário em linguagem simples (ele pode não ser técnico). Só peça ação humana quando for inevitável (escanear QR, aprovar instalação de pré-requisito).

**O que você está instalando:** um serviço local (Node.js) que conecta o(s) WhatsApp do usuário via WhatsApp Web multi-device e entrega:
1. **Resumo diário no próprio WhatsApp** ("mensagem para si mesmo"): conversas que ficaram sem resposta no dia + sugestões de resposta geradas por você (via `claude -p`).
2. **Dashboard local** (multi-conta, envio, busca, mídia) em `http://localhost:<porta>`.
3. **Controle pelo Claude Code** via MCP: o usuário poderá te pedir "o que ficou sem resposta hoje?", "responde o João dizendo X", etc.

**Princípios:** tudo roda e fica na máquina do usuário. Nenhum dado sai para servidor de terceiros. Não há API key — as sugestões usam a assinatura Claude que o usuário já tem.

---

## Passo 0 — Pré-requisitos

1. **Node.js 20+**: verifique com `node --version`.
   - Ausente/antigo → instale a versão LTS: Windows `winget install OpenJS.NodeJS.LTS`; macOS `brew install node` (se não houver brew, baixe o instalador oficial de nodejs.org e peça pro usuário executar).
2. **Git**: verifique com `git --version`; instale se faltar (winget/xcode-select).

## Passo 1 — Obter o código e instalar dependências

```bash
git clone https://github.com/franciscobezerra/wa-concierge wa-concierge
cd wa-concierge
npm install
```

- `better-sqlite3` compila nativo mas tem prebuilds para Win/Mac em Node LTS. Se o install falhar nele, confirme Node LTS (não versão ímpar/experimental) e tente de novo.

## Passo 2 — Configuração

```bash
node scripts/setup.js
```

Interativo (Enter aceita o padrão): porta do dashboard (padrão 3000 — se ocupada, escolha outra, ex. 3010) e hora do resumo diário (padrão 18h — pergunte ao usuário que hora prefere).

O setup imprime: **senha do dashboard**, **chave MCP** e o comando `claude mcp add` pronto. **Mostre a senha ao usuário e diga para guardá-la.**

## Passo 3 — Primeira execução + parear WhatsApp (ação humana)

1. Inicie: `npm start` (deixe rodando; use execução em background).
2. Confirme que subiu: `http://localhost:<porta>` deve responder (redireciona para /login.html).
3. Abra o dashboard no navegador do usuário e oriente:
   - Entrar com a senha do setup.
   - "Adicionar conta" → id `pessoal` (ou `business` para WhatsApp Business), tipo correspondente.
   - Aparece um **QR code** → no celular: WhatsApp → Configurações → **Aparelhos conectados** → Conectar aparelho → escanear.
4. Repita para a segunda conta se o usuário tiver (pessoal + business é o caso comum).
5. Verifique: `GET http://localhost:<porta>/api/accounts` (autenticado com cookie do login) deve mostrar `live_connected: true`.
6. Avise que o histórico começa a sincronizar; as primeiras horas podem ter poucos dados.

## Passo 4 — Iniciar junto com o computador

### Windows (sem precisar de administrador)
Crie `start-hidden.vbs` NA PASTA DO PROJETO com o conteúdo do template `templates/start-hidden.vbs` (ajuste o caminho absoluto do projeto dentro dele). Depois crie um atalho para esse .vbs na pasta Startup do usuário:

```powershell
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut("$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\wa-concierge.lnk")
$sc.TargetPath = "<CAMINHO_DO_PROJETO>\start-hidden.vbs"
$sc.Save()
```

Isso NÃO exige elevação/UAC. O .vbs roda o servidor oculto com um loop de restart (até 20 tentativas) e um port-check para nunca duplicar.

### macOS
Copie `templates/com.waconcierge.plist` para `~/Library/LaunchAgents/`, substituindo `NODE_PATH_AQUI` (resultado de `which node`) e `PROJETO_AQUI` (caminho absoluto do projeto). Depois:

```bash
launchctl load ~/Library/LaunchAgents/com.waconcierge.plist
```

`KeepAlive` reinicia o processo se cair. Não usa sudo.

## Passo 5 — Conectar ao Claude Code (MCP)

Rode o comando que o setup imprimiu (fora do diretório também funciona):

```bash
claude mcp add whatsapp -- node "<CAMINHO>/src/mcp-entry.js" --key <CHAVE_DO_SETUP>
```

Teste: em uma nova conversa sua, chame a tool de listar contas do MCP `whatsapp` e confirme que responde.

## Passo 6 — Verificação final + entrega ao usuário

1. Envie uma mensagem de teste do dashboard (ou via MCP) para o próprio número do usuário e confirme que chega no celular.
2. Rode `npm run digest:test` — gera um resumo de demonstração (sem enviar) e mostra no terminal.
3. Explique ao usuário, em poucas linhas:
   - Todo dia às `<hora>` ele recebe no **próprio WhatsApp** o resumo do que ficou sem resposta, com sugestões prontas.
   - Ele pode te pedir coisas como: *"o que ficou sem resposta hoje?"*, *"responde a Maria dizendo que amanhã 14h fica ótimo"*, *"busca a última mensagem do contador"*.
   - O dashboard em `http://localhost:<porta>` mostra tudo e serve para reconectar (QR) se um dia deslogar.
   - Se algo cair, o sistema **se reconecta sozinho**; ele só será chamado se precisar escanear QR de novo (avisado no próprio WhatsApp).

## Troubleshooting

| Sintoma | Causa provável | Correção |
|---|---|---|
| `EADDRINUSE` no start | porta ocupada | re-rode `node scripts/setup.js` e escolha outra porta |
| QR não aparece | conexão em andamento | aguarde 15s; recarregue o dashboard; veja o log do `npm start` |
| Conta cai com "logged out" | sessão invalidada pelo celular | dashboard → Conectar → novo QR (o sistema avisa no WhatsApp do usuário quando isso acontece) |
| `better-sqlite3` falha no `npm install` | Node não-LTS sem prebuild | instale Node LTS 20/22 e re-rode `npm install` |
| Sugestões não aparecem no resumo | CLI `claude` fora do PATH do serviço | o resumo continua funcionando sem sugestões; confirme `claude --version` no mesmo shell do serviço |
