import oneCSvg from './service-icons/1c.svg?raw'
import apacheSvg from './service-icons/apache.svg?raw'
import cloudflareSvg from './service-icons/cloudflare.svg?raw'
import dockerSvg from './service-icons/docker.svg?raw'
import moodleSvg from './service-icons/moodle.svg?raw'
import nginxSvg from './service-icons/nginx.svg?raw'
import opnsenseSvg from './service-icons/opnsense.svg?raw'
import postgresqlSvg from './service-icons/postgresql.svg?raw'

const asLocalIcon = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`

/** Bundled brand icons are copied into the operator layout on selection. */
export const serviceIcons = [
  { id: '1c', label: '1C', icon: asLocalIcon(oneCSvg) },
  { id: 'apache', label: 'Apache', icon: asLocalIcon(apacheSvg) },
  { id: 'cloudflare', label: 'Cloudflare', icon: asLocalIcon(cloudflareSvg) },
  { id: 'docker', label: 'Docker', icon: asLocalIcon(dockerSvg) },
  { id: 'moodle', label: 'Moodle', icon: asLocalIcon(moodleSvg) },
  { id: 'nginx', label: 'NGINX', icon: asLocalIcon(nginxSvg) },
  { id: 'opnsense', label: 'OPNsense', icon: asLocalIcon(opnsenseSvg) },
  { id: 'postgresql', label: 'PostgreSQL', icon: asLocalIcon(postgresqlSvg) },
]
