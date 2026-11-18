import { type Node, nodeStatusLabel } from '../../api';
import { Badge } from '../../ui';

const tone = { ok: 'green', missing: 'red', disabled: 'zinc', unsupported: 'amber', unknown: 'amber' } as const;
const hints: Record<Node['status'], string> = {
  ok: '',
  missing: '入站或客户端已在 3x-ui 中删除，订阅会暂时跳过它。',
  disabled: '入站或客户端在 3x-ui 中被停用，订阅会暂时跳过它。',
  unsupported: '主控还不能为这种协议或传输方式生成分享链接。',
  unknown: '这台机器的 gateway 版本过旧，请升级后同步。'
};

export function NodeStatus({ node }: { node: Pick<Node, 'status' | 'unsupported'> }) {
  return (
    <span title={hints[node.status] + (node.unsupported ? `（${node.unsupported}）` : '')}>
      <Badge tone={tone[node.status]}>{nodeStatusLabel[node.status]}</Badge>
    </span>
  );
}

export const inboundLabel = (n: Pick<Node, 'inboundRemark' | 'protocol' | 'port' | 'inboundId'>) => (n.protocol ? `${n.inboundRemark || '#' + n.inboundId} · ${n.protocol.toUpperCase()} ${n.port}` : `入站 #${n.inboundId}`);
