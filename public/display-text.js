// Presentation only: leave imported source records intact.
export function visibleConversationText(text) {
  return String(text ?? '')
    .replace(/<environment_context(?:\s[^>]*)?>[\s\S]*?(?:<\/environment_context\s*>|$)/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Only recognize attachment declarations inside the imported pasted-files section.
export function pastedDocuments(text) {
  const files=[];
  const source=String(text??'');
  const section=/^# Files pasted by the user:[^\n]*\n([\s\S]*?)(?=^# (?!#)|$(?![\s\S]))/m.exec(source);
  if(!section)return {text:source,files};
  const cleaned=section[1].replace(/^##\s+(.+?):\s*(\/[^\r\n]+)\s*$/gm,(line,label,path)=>{
    path=path.trim();files.push({label:label.replace(/^"|"$/g,''),path,name:path.split('/').pop()||'文档'});return '';
  });
  return {text:files.length?source.replace(section[0],cleaned.trim()):source,files};
}
