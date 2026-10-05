"""Render the small, trusted study-report Markdown subset with HTML escaped."""
import html,re
def inline(text):
 text=text.replace('$\\ge$','≥').replace('$\\rightarrow$','→')
 text=html.escape(text)
 return re.sub(r'\*\*(.+?)\*\*',r'<strong>\1</strong>',text)
def render(text):
 out=[];table=False
 for line in text.splitlines():
  line=line.strip()
  if table and not line.startswith('|'):out.append('</tbody></table></div>');table=False
  if not line or line=='---':continue
  if line.startswith('|'):
   cells=[c.strip() for c in line.strip('|').split('|')]
   if all(re.fullmatch(r':?-+:?',c.replace(' ','')) for c in cells):continue
   if not table:out.append('<div style="overflow-x:auto"><table><tbody>');table=True
   out.append('<tr>'+''.join('<td>'+inline(c)+'</td>' for c in cells)+'</tr>');continue
  heading=re.match(r'^(#{1,6})\s+(.+)',line)
  if heading:
   level=min(6,len(heading[1])+2);out.append(f'<h{level}>'+inline(heading[2])+f'</h{level}>')
  elif line.startswith('>'):out.append('<blockquote>'+inline(line.lstrip('> '))+'</blockquote>')
  else:out.append('<p>'+inline(line)+'</p>')
 if table:out.append('</tbody></table></div>')
 return '\n'.join(out)
