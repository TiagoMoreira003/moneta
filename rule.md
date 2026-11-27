# Regra: esquema de cores "Preto + Verde"

A app **Moneta** usa **sempre** este esquema de cores, num tema escuro: fundo preto que desce para verde
esmeralda, inspirado numa imagem de referência (preto quente em cima, verde em baixo, um símbolo branco ao centro).
Qualquer ecrã, componente ou gráfico novo segue esta regra.

## Princípios

1. **O verde é a marca, e é subtil.** Aparece como luz no fundo, nos botões de ação e nos valores positivos. Nunca pinta a interface toda.
2. **O fundo vai do preto ao verde e chega sempre ao fundo da página**, mesmo em páginas curtas (o gradiente vive no `<html>`, fixo ao ecrã).
3. **O branco é o destaque máximo.** Usa-se pouco: separador ativo, mensagem do utilizador, números principais.
4. **As cores têm significado.** Verde = ganho/positivo/ação; vermelho = perda/negativo/erro; âmbar = aviso; azul = informação. **Perder dinheiro é sempre vermelho** (valores, linhas de evolução que descem, ícones de passivos).
5. **Dados usam várias cores**, não só verdes: empresas, setores e categorias distinguem-se por uma paleta multicolor suave, no mesmo tom (pastéis vivos de nível "400", legíveis no escuro), que convive com o verde.
6. **Ícones são neutros por omissão** (branco translúcido); só ganham cor quando a cor quer dizer algo.
7. **Um só tema.** A app não muda para claro com o sistema operativo.

## Tokens de interface (CSS)

| Token | Valor | Uso |
|---|---|---|
| `--bg` | `#080a09` | Base |
| Fundo (`html`) | linear `#0c0607 → #080a09 → #0a1a13 → #0f3324` + brilho radial `rgba(24,140,92,.62)` em baixo, fixo | Página inteira |
| `--card` | `#101513` (+ brilho `rgba(255,255,255,.035)` no topo) | Cartões |
| `--card-2` | `#18201c` | Superfícies dentro de cartões |
| `--hair` / `--line` | `rgba(255,255,255,.06)` / `.09` | Contornos |
| `--ink` / `--ink-2` / `--muted` | `#eef4f0` / `#c2cdc7` / `#7d8a84` | Texto |
| `--accent` | `#2ecc8a` | Verde de marca (links, foco, realces) |
| `--cta` | gradiente `#4be3a2 → #22b277`, texto `#03140c` | Botões de ação |

## Cores de significado

| Significado | Cor |
|---|---|
| Positivo / ganho | `#3ddc97` |
| Negativo / perda / erro | `#ff6b6b` |
| Aviso | `#f5b84b` |
| Informação | `#60a5fa` |

## Paleta de dados (gráficos, empresas, setores, categorias)

Por ordem de uso: `#2ecc8a` verde · `#60a5fa` azul · `#f5b84b` âmbar · `#a78bfa` violeta · `#fb7185` rosa-coral · `#2dd4bf` teal · `#fb923c` laranja · `#a3e635` lima · `#f472b6` rosa · `#22d3ee` ciano · `#d6c7a1` areia · `#94a3b8` ardósia.

Atribuições fixas: Ações `#2ecc8a`, ETFs `#60a5fa`, Fundo de emergência `#f5b84b`, PPR `#a78bfa`, Dívidas `#ff6b6b`.
Setores: Tecnologia azul, Saúde verde, Financeiro âmbar, Energia laranja, Utilities ciano, Comunicação violeta, Consumo discricionário rosa, Consumo básico lima, Materiais areia, Industrial ardósia, Ouro amarelo `#facc15`, ETF diversificado teal.

Regra: o vermelho `#ff6b6b` nunca se usa como cor de categoria comum (fica reservado para perdas e dívidas).

## Componentes

- **Separador ativo / segmento ativo:** pílula `#eef4f0`, texto `#06120c`.
- **Botões redondos:** `rgba(255,255,255,.04)` + contorno `--hair`.
- **Mensagem do utilizador:** bolha `#eef4f0`, texto `#06120c`. Assistente: `rgba(255,255,255,.05)`.
- **Avatar do assistente:** inicial "A" em `--accent` sobre `rgba(46,204,138,.14)` (provisório; sem "orbe de IA").
- **Empresas:** sem logótipos; o ticker num quadrado claro `#f4f7f5`, texto `#080a09` peso 800 (como no Paper).
- **Gráfico de evolução:** verde se o património subiu no período, vermelho se desceu.

## Verificação

Contraste mínimo 4.5:1 para texto sobre `--card`. Testar no ecrã largo, no telemóvel e numa página curta (o verde tem de chegar ao fundo).
