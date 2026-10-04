import { Link } from 'react-router';
import { Button } from '../components/ui/button';
export default function NotFound() { return <div className="empty-state"><h1>没有找到这个页面</h1><p>页面可能已移动，请从工作台导航继续。</p><Button asChild><Link to="/">返回工作台</Link></Button></div>; }
