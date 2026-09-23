import { Button } from '@heroui/react';
import { BookOpen, Database, FileText, Github, Hash, Library, MessageSquare, Settings2, type LucideIcon } from 'lucide-react';
import { getLocale, t } from '../lib/i18n';
import type { Source } from '../lib/types';
import { Brand } from './components';

export const SOURCES: { value: 'all' | Source; label: string; icon: LucideIcon }[] = [
  { value: 'all', label: '全部收藏', icon: Library },
  { value: 'github', label: 'GitHub', icon: Github },
  { value: 'article', label: '文章', icon: FileText },
  { value: 'docs', label: '文档', icon: BookOpen },
];

export function Navigation({ active, counts, tags = [], selectedTag = '', onSource, onTag, onOptions, onChat }: {
  active: 'all' | Source | 'settings' | 'chat'; counts?: Record<'all' | Source, number>; tags?: string[]; selectedTag?: string;
  onSource: (source: 'all' | Source) => void; onTag?: (tag: string) => void; onOptions: () => void; onChat?: () => void;
}) {
  return <aside className="sidebar">
    <Brand />
    <nav aria-label={t('主导航')}>
      <p className="nav-caption">{t('资料库')}</p>
      <div className="nav-group">
        {onChat && <Button variant="ghost" aria-label={t('打开对话查询')} className={`nav-item ${active === 'chat' ? 'active' : ''}`} aria-current={active === 'chat' ? 'page' : undefined} onPress={onChat}><MessageSquare size={17} aria-hidden="true" /><span>{t('对话查询')}</span></Button>}
        {SOURCES.filter(source => active !== 'settings' || source.value === 'all').map(({ value, label, icon: Icon }) => <Button
          key={value} variant="ghost" className={`nav-item ${active === value ? 'active' : ''}`}
          aria-current={active === value ? 'page' : undefined} onPress={() => onSource(value)}>
          <Icon size={17} aria-hidden="true" /><span>{t(label)}</span>{counts && <span className="nav-count">{counts[value].toLocaleString(getLocale())}</span>}
        </Button>)}
      </div>
      {onTag && tags.length > 0 && <div className="sidebar-tags">
        <p className="nav-caption">{t('标签')}</p>
        {tags.slice(0, 10).map(tag => <Button key={tag} size="sm" variant="ghost" className={`nav-item tag-nav ${selectedTag === tag ? 'active' : ''}`} onPress={() => onTag(selectedTag === tag ? '' : tag)} aria-pressed={selectedTag === tag}>
          <Hash size={14} aria-hidden="true" /><span>{tag}</span>
        </Button>)}
      </div>}
    </nav>
    <div className="sidebar-bottom">
      <Button variant="ghost" className={`nav-item ${active === 'settings' ? 'active' : ''}`} aria-current={active === 'settings' ? 'page' : undefined} onPress={onOptions}><Settings2 size={17} aria-hidden="true" /><span>{t('设置与数据')}</span></Button>
      <p className="sidebar-foot"><Database size={13} aria-hidden="true" />{t('保存在此浏览器')}</p>
    </div>
  </aside>;
}
