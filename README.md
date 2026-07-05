# 🤖 wa-concierge

**Seu WhatsApp com um concierge próprio, rodando 100% no seu computador.**

- 📬 **Resumo diário no seu próprio WhatsApp**: as conversas que ficaram sem resposta no dia, com sugestões de resposta prontas (geradas pelo seu Claude).
- 🎛️ **Dashboard local** multi-conta (pessoal + business): histórico, busca, envio, mídia, grupos.
- 💬 **Comande pelo Claude Code**: "o que ficou sem resposta hoje?", "responde o João que amanhã 14h tá ótimo", "busca a última mensagem da contadora".
- 🔒 **Privado por construção**: seus dados nunca saem da sua máquina. Sem servidor de terceiros, sem API key, código aberto.
- 🔧 **Se cura sozinho**: caiu a conexão, ele reconecta; só te chama (no seu próprio WhatsApp) se precisar escanear QR de novo.

## Como instalar

Você não instala — **seu Claude Code instala pra você**, num setup guiado de ~10 minutos:

1. Tenha o [Claude Code](https://claude.com/claude-code) instalado.
2. Baixe o arquivo [`INSTALAR.md`](./INSTALAR.md) deste repositório.
3. Arraste ele pra dentro do Claude Code e diga: **"instala isso pra mim"**.

Ele te pergunta o que precisa (qual conta, que horas quer o resumo), conecta seu WhatsApp por QR code (igual WhatsApp Web) e deixa tudo rodando, inclusive quando o computador reiniciar.

## Requisitos

- Windows 10/11 ou macOS
- [Claude Code](https://claude.com/claude-code) (qualquer plano)
- Node.js 20+ (o instalador resolve se faltar)
- Computador ligado para o concierge trabalhar (se estiver desligado na hora do resumo, ele chega minutos depois que você ligar)

## Perguntas honestas

**Isso é oficial do WhatsApp?** Não. Usa a [Baileys](https://github.com/WhiskeySockets/Baileys), biblioteca open-source que fala o protocolo do WhatsApp Web (multi-device). É o padrão de mercado para automação pessoal, mas **não é API oficial**: existe formalmente a possibilidade de o WhatsApp restringir contas com automação. O risco na prática é baixo para uso pessoal moderado, e a decisão é sua.

**Meus dados vão pra algum lugar?** Não. Mensagens, mídia e credenciais de sessão ficam em `data/` na sua máquina (fora do git). As sugestões de resposta são geradas pelo **seu** Claude, com a **sua** assinatura.

**Quanto custa?** O software é grátis (MIT). As sugestões usam o plano Claude que você já tem.

## Arquitetura (resumo)

```
src/
├── whatsapp/     conexão multi-conta (Baileys), reconexão com backoff
├── web/          dashboard local (Express + Socket.IO), autenticado
├── db/           SQLite local (histórico, contatos, permissões de grupo)
├── mcp/          servidor MCP — as tools que o seu Claude Code usa
├── concierge/    o digest diário (detecção de conversas esquecidas + rascunhos)
├── monitor/      auto-cura: reconecta contas caídas, avisa só quando precisa de QR
└── scheduler/    mensagens agendadas
```

## Licença

MIT. Use, audite, modifique.
