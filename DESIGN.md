# Direção de design

Leitura: dashboard de património pessoal para um investidor em Portugal, na linguagem preto → verde do `rule.md`.

Dial: ENERGY 2 / RHYTHM 2 / MOTION 2

## Identidade

- **Paleta:** ver `rule.md`. Fundo preto que desce para verde; o verde é a marca e aparece pouco.
- **Motivo de identidade:** as colunas da Distribuição como no Paper: a maior sólida e destacada pelo fundo da coluna, as outras tracejadas (estáticas).
- **Foco por ecrã:** o património líquido na Visão geral; a carteira em Investimentos; o total a pôr de parte em Impostos.
- **Marca:** **Moneta** (de Juno Moneta, onde se cunhava moeda). Símbolo "Cunho": um M de uma só forma com um V ao centro, e a moeda verde a cair do V. Nome em minúsculas ("moneta"), peso 800. Na interface: M em `--ink`, moeda em `--accent`; no telemóvel só o M. Os mockups foram desenhados no Paper.

## Decisões e motivos (uma linha cada)

- **Tema escuro fixo:** é a identidade da imagem de referência escolhida para o projeto, não um "look tech".
- **Tipografia Manrope (Google Fonts, com a do sistema como reserva):** é a do desenho no Paper; números tabulares, títulos em peso 800 com tracking negativo.
- **Grelha de cartões na Visão geral:** pedida a partir da imagem de referência; cada cartão responde a uma pergunta (quanto tenho, onde está, quanto rendem os juros, quanto falta no PPR, quando chegam dividendos). Três colunas independentes como no Paper (360 / 628 / 340): Património, PPR e Assistente; Distribuição e Evolução; Trading 212 e Dividendos. O último cartão de cada coluna estica para as três acabarem alinhadas.
- **Navegação em pílula:** pedida a partir da imagem de referência; a pílula desliza para dizer em que página estás.
- **Cores de dados variadas:** cada empresa, setor e categoria precisa de se distinguir nos gráficos; o vermelho fica reservado para perdas.
- **Movimento:** entrada em cascata ao mudar de página (orientação), pílula a deslizar (localização), contagem do património na primeira abertura. Nada fica em loop.
- **Sombras:** os cartões não flutuam; só os diálogos sobem de nível.
- **Vidro (blur):** só na barra de topo e na barra inferior do telemóvel, que passam por cima do conteúdo.
- **Brilho:** só no botão "Adicionar".
- **Setas ↗:** retiradas da Visão geral, como no desenho do Paper (artboard "Moneta · Visão geral (desktop)").
- **Avatar do assistente:** a inicial "A", provisória, em vez de uma "orbe de IA".

## Exceções aprovadas (regras antislop)

- R-05 (grelha bento): mantida por decisão de design (14/11/2026). Cada cartão responde a uma pergunta concreta; não acrescentar cartões só para preencher a grelha.
- R-11 (navegação em pílula): forma pedida na referência; o resto dos elementos tem raios variados.
