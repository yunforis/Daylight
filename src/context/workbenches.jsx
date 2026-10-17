import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { GraduationCap, Mail, ReceiptText, Users } from 'lucide-react';
import { request } from '@/lib/api';
import { useWorkspace } from '@/context/workspace';

export const WORKBENCH_FEATURES = [
  {
    id: 'invoices',
    name: '发票助手',
    description: '集中核对邮件附件中的发票，复制票据信息并查看原件。',
    path: '/app/invoices',
    icon: ReceiptText,
    keywords: '发票 报销 invoice',
  },
  {
    id: 'recruitment',
    name: '智能招聘',
    description: '管理候选人和简历，自然语言筛选人才，审核并发送面试邀约。',
    path: '/app/recruitment',
    icon: Users,
    keywords: '招聘 人才 候选人 简历 面试 HR recruitment',
  },
  {
    id: 'campus-study',
    name: '科大学习站',
    description: '同步研究生课表、Piazza 与 Blackboard 课件，并按已导入资料提问。',
    path: '/app/campus',
    icon: GraduationCap,
    keywords: '课表 课件 作业 Piazza Blackboard 上科大',
  },
  {
    id: 'mail-client',
    name: '邮件收发',
    description: '用 QQ 邮箱和网易邮箱收信、写信、转发、群发，并让助手起草。',
    path: '/app/mail-desk',
    icon: Mail,
    keywords: '邮件 收件箱 草稿 转发 抄送 QQ 网易',
  },
];

export function isRecruitmentTemplate(template) {
  return template?.id === 'recruitment' || Boolean(template?.capabilities?.includes('recruitment.use'));
}

export function dedicatedWorkbenchPath(templateId) {
  if (templateId === 'campus-study') return '/app/campus';
  if (templateId === 'mail-client') return '/app/mail-desk';
  return '';
}

const WorkbenchesContext = createContext(null);

export function WorkbenchesProvider({ children }) {
  const { jobsVersion } = useWorkspace();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const requestEpoch = useRef(0);
  const location = useLocation();
  const workbenchLocation = (location.pathname.startsWith('/app/workbenches') || location.pathname.startsWith('/app/campus') || location.pathname.startsWith('/app/mail-desk'))
    ? `${location.pathname}${location.search}` : '';
  const reload = useCallback(async () => {
    const epoch = ++requestEpoch.current;
    setLoading(true);
    try {
      const result = await request('/scenarios');
      if (epoch === requestEpoch.current) {
        setData(result);
        setError('');
      }
      return result;
    } catch (error) {
      if (epoch === requestEpoch.current) setError(error.message);
      throw error;
    } finally {
      if (epoch === requestEpoch.current) setLoading(false);
    }
  }, []);

  useEffect(() => { reload().catch(() => {}); }, [reload, workbenchLocation, jobsVersion]);
  useEffect(() => {
    const refresh = () => { reload().catch(() => {}); };
    window.addEventListener('focus', refresh);
    return () => { window.removeEventListener('focus', refresh); };
  }, [reload]);

  const value = useMemo(() => {
    const scenarioWorkbenches = data?.workbenches || [];
    return {
      data,
      error,
      loading,
      reload,
      scenarioWorkbenches,
      visibleFeatures: data ? WORKBENCH_FEATURES.filter((feature) => {
        if (data.navigation?.hiddenFeatureIds?.includes(feature.id)) return false;
        if ((feature.id === 'campus-study' || feature.id === 'mail-client') && !scenarioWorkbenches.some((item) => !item.archived && item.template?.id === feature.id)) return false;
        return true;
      }) : [],
      visibleWorkbenches: scenarioWorkbenches.filter((workbench) => !workbench.archived && !data.navigation?.hiddenWorkbenchIds?.includes(workbench.id) && !dedicatedWorkbenchPath(workbench.template?.id)),
    };
  }, [data, error, loading, reload]);

  return <WorkbenchesContext.Provider value={value}>{children}</WorkbenchesContext.Provider>;
}

export function useWorkbenches() {
  const value = useContext(WorkbenchesContext);
  if (!value) throw new Error('useWorkbenches must be used within WorkbenchesProvider');
  return value;
}