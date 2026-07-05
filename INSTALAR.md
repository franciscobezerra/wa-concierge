# 🤖 wa-concierge — seu WhatsApp com concierge próprio

> **Você, humano:** arraste este arquivo para dentro do Claude Code (ou cole o conteúdo) e escreva: **"instala isso pra mim"**. O Claude cuida do resto e te pergunta o que precisar. Leva ~10 minutos.

---

## Instruções para o agente (Claude Code)

Você vai instalar o **wa-concierge** para o seu usuário, em formato de **setup guiado**: converse, pergunte, execute, e entregue funcionando. O usuário pode não ser técnico — traduza tudo para linguagem simples e nunca despeje log bruto nele.

### O que é o produto (explique isso a ele no início, em 3-4 linhas)

- Todo dia, num horário que ele escolhe, ele recebe **no próprio WhatsApp** (naquele chat "você mesmo") um resumo das **conversas que ficaram sem resposta** no dia, com **sugestões de resposta prontas**.
- Ele passa a poder **comandar o WhatsApp por você** (Claude): "o que ficou sem resposta hoje?", "responde o João que amanhã 14h tá ótimo", "busca a última mensagem da contadora".
- Tudo roda **100% no computador dele**. Nada vai para servidor de terceiros. Código aberto, auditável. Sem API key — as sugestões usam a assinatura Claude dele.
- Ponto honesto que você deve mencionar: usa a mesma tecnologia do WhatsApp Web via biblioteca não-oficial (Baileys). É o padrão do mercado para isso e o risco é baixo, mas existe formalmente a possibilidade de o WhatsApp restringir contas que usam automação. Ele decide.

### Fluxo do setup guiado

**Etapa 1 — Conversa inicial.** Apresente o produto (acima), confirme que ele quer instalar, e colete numa única rodada de perguntas:
1. Quer conectar o WhatsApp **pessoal**, o **business**, ou **os dois**?
2. **Que horas** quer receber o resumo diário? (sugira 18h)
3. Confirme que ele tem o celular em mãos (vai escanear QR code, igual WhatsApp Web).

**Etapa 2 — Pré-requisitos.** Verifique `node --version` (precisa 20+) e `git --version`. Se faltar: Windows `winget install OpenJS.NodeJS.LTS`; macOS `brew install node` (sem brew: instalador de nodejs.org). Explique o que está fazendo em uma linha, sem jargão.

**Etapa 3 — Código e configuração.**
```bash
git clone https://github.com/franciscobezerra/wa-concierge wa-concierge
cd wa-concierge
npm install
node scripts/setup.js --port 3000 --hour <hora_escolhida>
```
- Se a porta 3000 estiver ocupada na máquina, use outra (ex. 3010).
- O setup imprime a **senha do dashboard** e a **chave MCP**. Mostre a senha ao usuário e peça para guardar.
- Se `npm install` falhar em `better-sqlite3`: confirme Node LTS e repita.

**Etapa 4 — Conectar o WhatsApp (a parte dele).** Inicie o servidor (`npm start`, em background), abra `http://localhost:<porta>` no navegador dele e guie por voz de texto:
1. Entrar com a senha.
2. "Adicionar conta" → id `pessoal` (e/ou `business`), tipo correspondente.
3. No celular: WhatsApp → Configurações → **Aparelhos conectados** → **Conectar aparelho** → escanear o QR da tela.
4. Repita para a segunda conta se for o caso.
5. Confirme conectado: `/api/accounts` deve mostrar `live_connected: true` para cada conta. O histórico começa a sincronizar sozinho.

**Etapa 5 — Ligar junto com o computador.**
- **Windows (sem UAC):** copie `templates/start-server.bat` e `templates/start-hidden.vbs` para a raiz do projeto substituindo `PROJETO_AQUI` (caminho absoluto) e `PORTA_AQUI`; crie um atalho para o .vbs em `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\` (via WScript.Shell CreateShortcut). Não use Register-ScheduledTask — exige admin sem necessidade.
- **macOS:** copie `templates/com.waconcierge.plist` para `~/Library/LaunchAgents/` substituindo `NODE_PATH_AQUI` (`which node`) e `PROJETO_AQUI`; depois `launchctl load ~/Library/LaunchAgents/com.waconcierge.plist`.

**Etapa 6 — Conectar a você (MCP).** Rode o comando `claude mcp add` que o setup imprimiu. Confirme chamando a tool de listar contas do servidor MCP `whatsapp`.

**Etapa 7 — Prova de vida + entrega.**
1. `npm run digest:test` — mostra ao usuário como o resumo detecta conversas esquecidas (demo local, não envia nada).
2. Envie pelo MCP uma mensagem de boas-vindas **para o próprio número dele** (chat "você mesmo"):
   > 🤖 Seu concierge de WhatsApp está ativo! Todo dia às <hora>h eu te mando aqui o resumo do que ficou sem resposta, com sugestões prontas. Você também pode me comandar pelo Claude Code: "responde o João que...", "o que ficou pendente hoje?".
3. Confirme com ele que a mensagem chegou no celular. Está entregue.
4. Feche explicando em 3 linhas o que ele tem agora e que, se um dia uma conta deslogar, o sistema se reconecta sozinho e só chama ele se precisar de um novo QR (avisado no próprio WhatsApp).

### Se algo der errado

Consulte o `INSTALL.md` do repositório (tabela de troubleshooting). Regra geral: `EADDRINUSE` = trocar porta no setup; QR não aparece = aguardar 15s e recarregar; `better-sqlite3` = Node LTS.
