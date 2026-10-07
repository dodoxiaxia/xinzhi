"""Offline public-field regressions; no publishers, PDFs or models."""
import copy
import hashlib
import json
import socket
import unittest
import xml.etree.ElementTree as ET
from unittest.mock import patch

import abstract_quality as aq
import auto_picks
import build_public
import refresh_feeds
import week_precompute


class AbstractQualityTests(unittest.TestCase):
    def setUp(self):
        self.guard = patch.object(socket.socket, 'connect', side_effect=AssertionError('No network'))
        self.guard.start()
        self.addCleanup(self.guard.stop)
        self.evidence = json.loads(aq.EVIDENCE.read_text())['entries']

    def case(self, doi):
        entry = self.evidence[doi]
        return {'id':'case', 'title':entry['title'], 'doi':doi, 'summary':entry['observedSummary'],
                'summary_truncated':False, 'clinicalTier':'心血管旗舰顶刊', 'journal':'European Heart Journal'}

    def test_identity_and_whole_text_hash_are_required_for_legacy_correction(self):
        p=self.case('10.1161/jaha.126.050490')
        self.assertEqual(hashlib.sha256(p['summary'].encode()).hexdigest(), self.evidence[p['doi']]['matchingSummaryHashes'][0])
        for field,value in [('title','A different paper'),('doi','10.1000/other'),('summary','MethodsAmong is mentioned as a literal token.')]:
            other={**p,field:value}
            self.assertEqual(aq.normalize_paper(other),other)

    def test_jaha_legacy_joined_text_uses_verified_four_sections_without_mutation(self):
        p=self.case('10.1161/jaha.126.050490');before=copy.deepcopy(p)
        out=aq.normalize_paper(p)
        self.assertEqual(p,before)
        self.assertEqual([s['label'] for s in out['abstractSections']],['Background','Methods','Results','Conclusions'])
        self.assertIn('characterized.\n\nMethods: Among 3369',out['summary'])
        self.assertNotIn('MethodsAmong',out['summary'])
        for number in ('3369','2824','2.34','1.19','4.59','0.01','1.0%','1.89','1.18','3.03','0.008'):
            self.assertEqual(out['summary'].count(number),p['summary'].count(number))
        self.assertEqual(aq.normalize_paper(out),out)

    def test_ehj_funding_is_retained_as_metadata_and_not_an_abstract_or_pick(self):
        p=self.case('10.1093/eurheartj/ehag713');out=aq.normalize_paper(p)
        self.assertEqual(out['summary'],'')
        self.assertEqual(out['abstractSections'],[])
        self.assertEqual(out['abstractStatus'],'non_abstract_metadata')
        self.assertFalse(out['publicAbstractVerified'])
        self.assertEqual(out['nonAbstractMetadata'][0]['text'],p['summary'])
        self.assertFalse(auto_picks.has_content(p))
        self.assertEqual(auto_picks.score(p,{}),0)
        self.assertIsNone(week_precompute.public_abstract({**p,'publicAbstractVerified':True,'abstractSource':'Crossref'}))
        public=build_public.public_paper(p)
        self.assertEqual(public['summary'],'')
        self.assertEqual(public['nonAbstractMetadata'][0]['text'],p['summary'])

    def test_new_genuine_abstract_is_not_blocked_by_previous_ehj_correction(self):
        p=self.case('10.1093/eurheartj/ehag713')
        text=('Methods: Heart Research UK and NIHR supported 3369 patients under NIHR304448. '
              'DOIs 10.13039/501100000327 and 10.13039/501100000272 identify the funders. '
              'Results: HR 2.34 (95% CI 1.19–4.59), P=0.01. Conclusions: Further research is needed.')
        p.update(summary=text,publicAbstractVerified=True,abstractSource='Crossref')
        self.assertEqual(aq.normalize_paper(p)['summary'],text)
        self.assertTrue(auto_picks.has_content(p))
        self.assertEqual(week_precompute.public_abstract(p)['abstract'],text)

    def test_jats_headings_paragraphs_comparisons_and_inline_digits_survive(self):
        raw='<jats:sec><jats:title>Methods</jats:title><jats:p>Area &lt;4 mm<sup>2</sup>.</jats:p><jats:p>Index &gt;315; P&lt;0.001.</jats:p></jats:sec><jats:sec><jats:title>Results</jats:title><jats:p>HR 2.34.</jats:p></jats:sec>'
        out=aq.abstract_fields(raw)
        self.assertEqual(out['abstractSections'][0],{'label':'Methods','text':'Area <4 mm2.\n\nIndex >315; P<0.001.'})
        self.assertEqual(out['abstractSections'][1],{'label':'Results','text':'HR 2.34.'})

    def test_actual_funding_metadata_field_is_separated_but_abstract_funding_section_stays(self):
        raw='<abstract><sec><title>Funding</title><p>Heart Research UK supported 120 patients, award 100001.</p></sec></abstract><funding-group><award-group><funding-source>NIHR</funding-source><award-id>NIHR304448</award-id></award-group></funding-group>'
        out=aq.abstract_fields(raw)
        self.assertEqual(out['abstractSections'],[{'label':'Funding','text':'Heart Research UK supported 120 patients, award 100001.'}])
        self.assertEqual(out['nonAbstractMetadata'][0]['text'],'NIHRNIHR304448')
        self.assertNotIn('NIHR304448',out['summary'])

    def test_missing_or_unclosed_metadata_is_not_guessed(self):
        self.assertEqual(aq.abstract_fields('')['abstractStatus'],'missing')
        raw='<funding-group><award-group>NIHR304448'
        out=aq.abstract_fields(raw)
        self.assertEqual(out,{'summary':raw,'abstractStatus':'unverified'})
        self.assertFalse(aq.readable_abstract(out))

    def test_plain_markup_replaces_stale_sections_without_changing_the_source(self):
        p={'title':'Cardiac cohort', 'doi':'10.1000/plain',
           'summary':'<p>Among 120 patients.</p><p>HR 2.34.</p>',
           'abstractSections':[{'label':'Old results','text':'An obsolete result.'}]}
        before=copy.deepcopy(p)
        out=aq.normalize_paper(p)
        self.assertEqual(p,before)
        self.assertEqual(out['summary'],'Among 120 patients.\n\nHR 2.34.')
        self.assertEqual(out['abstractSections'],[])
        self.assertEqual(out['abstractStatus'],'available')
        self.assertNotIn('obsolete',json.dumps(build_public.public_paper(p)))
        self.assertEqual(aq.normalize_paper(out),out)

    def test_funding_only_markup_clears_stale_sections_in_the_public_reader(self):
        p={'title':'Cardiac priorities', 'doi':'10.1000/funding',
           'summary':'<funding-group><award-group><funding-source>NIHR</funding-source><award-id>NIHR304448</award-id></award-group></funding-group>',
           'abstractSections':[{'label':'Old results','text':'An obsolete result.'}]}
        out=aq.normalize_paper(p)
        self.assertEqual(out['summary'],'')
        self.assertEqual(out['abstractSections'],[])
        self.assertEqual(out['abstractStatus'],'non_abstract_metadata')
        self.assertEqual(out['nonAbstractMetadata'],[{'kind':'funding-group','text':'NIHRNIHR304448'}])
        self.assertFalse(aq.readable_abstract(out))
        self.assertFalse(auto_picks.has_content(p))
        self.assertIsNone(week_precompute.public_abstract(p))
        public=build_public.public_paper(p)
        self.assertEqual(public['abstractSections'],[])
        self.assertEqual(public['nonAbstractMetadata'],out['nonAbstractMetadata'])
        self.assertNotIn('obsolete',json.dumps(public))

    def test_unverified_markup_preserves_the_previous_representation(self):
        p={'title':'Cardiac cohort', 'doi':'10.1000/incomplete',
           'summary':'<funding-group><award-group>NIHR304448',
           'abstractSections':[{'label':'Previous','text':'Previously obtained text.'}]}
        out=aq.normalize_paper(p)
        self.assertEqual(out['summary'],p['summary'])
        self.assertEqual(out['abstractSections'],p['abstractSections'])
        self.assertEqual(out['abstractStatus'],'unverified')
        self.assertFalse(aq.readable_abstract(out))

    def test_encoded_angle_tags_are_not_decoded_and_reparsed(self):
        out=aq.abstract_fields('<p>Literal &lt;sup&gt;2&lt;/sup&gt; and &lt;5 &gt;6.</p>')
        self.assertEqual(out['summary'],'Literal <sup>2</sup> and <5 >6.')
        self.assertEqual(aq.normalize_paper(out)['summary'],out['summary'])

    def test_native_xml_description_sections_are_not_flattened_before_cleaning(self):
        xml='<rss><channel><item><title>Cardiac cohort</title><link>https://example.org/paper</link><description><sec><title>Methods</title><p>Among 3369 patients.</p></sec><sec><title>Results</title><p>HR 2.34.</p></sec></description></item></channel></rss>'
        out=refresh_feeds.parse_feed(xml.encode(),{'id':'test','name':'Heart','url':'https://example.org/rss'})
        self.assertEqual(out['items'][0]['abstractSections'],[{'label':'Methods','text':'Among 3369 patients.'},{'label':'Results','text':'HR 2.34.'}])

    def test_official_ehj_feed_description_does_not_increment_abstract_count(self):
        p=self.case('10.1093/eurheartj/ehag713')
        root=ET.Element('rss');item=ET.SubElement(ET.SubElement(root,'channel'),'item')
        for field,value in [('title',p['title']),('link','https://doi.org/'+p['doi']),('description','<span class="paragraphSection">'+p['summary']+'</span>')]:ET.SubElement(item,field).text=value
        out=refresh_feeds.parse_feed(ET.tostring(root),{'id':'test','name':'Heart','url':'https://example.org/rss'})
        self.assertEqual(out['rawItems'],1)
        self.assertEqual(out['itemsWithAbstracts'],0)
        self.assertEqual(out['items'][0]['abstractStatus'],'non_abstract_metadata')


if __name__=='__main__':unittest.main()
